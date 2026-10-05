import { Database, type Statement } from "bun:sqlite";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  SQLiteRemoteSession,
  SqliteRemoteDatabase,
  type RemoteCallback,
} from "drizzle-orm/sqlite-proxy";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeError } from "$lib/server/errors";
import * as schema from "./schema";
import type {
  Backend,
  BackendTransaction,
  DB,
  TransactionMode,
} from "./backend";
import { Gate, GateToken } from "./gate";

export const DEFAULT_GATE_TIMEOUT_MS = 30_000;
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 60_000;
const STATEMENT_CACHE_SIZE = 512;

export interface SqliteOptions {
  /** How long a caller waits for the connection before failing. */
  gateTimeoutMs?: number;
  /**
   * How long one transaction may hold the connection. A transaction that is
   * still open then is rolled back and the connection handed on, so a body
   * that never settles cannot wedge the database.
   */
  transactionTimeoutMs?: number;
}

const tables = extractTablesRelationalConfig(
  schema,
  createTableRelationsHelpers,
);
const relational = {
  fullSchema: schema,
  schema: tables.tables,
  tableNamesMap: tables.tableNamesMap,
};
const dialect = new SQLiteAsyncDialect();

/**
 * What `drizzle(callback, { schema })` builds, minus the per-call schema
 * analysis: every transaction gets its own instance, so this runs per
 * transaction and must stay cheap.
 */
function instance(callback: RemoteCallback): DB {
  const session = new SQLiteRemoteSession(
    callback,
    dialect,
    relational,
    undefined,
    {},
  );
  return new SqliteRemoteDatabase(
    "async",
    dialect,
    session,
    relational,
  ) as unknown as DB;
}

type Row = unknown[];
type Result = Awaited<ReturnType<RemoteCallback>>;

/**
 * sqlite-proxy on the existing `bun:sqlite` handle. The driver is async while
 * `bun:sqlite` is not, so every statement runs to completion synchronously and
 * the gate decides who may run one: a transaction owns the connection from
 * BEGIN to COMMIT, and every other caller waits its turn in FIFO order.
 */
class SqliteBackend implements Backend {
  readonly gate: Gate;
  readonly root: DB;
  #statements = new Map<string, Statement>();
  #closed = false;
  #watchdogs = new Set<ReturnType<typeof setTimeout>>();
  readonly #transactionTimeoutMs: number;

  constructor(
    readonly client: Database,
    options: SqliteOptions,
  ) {
    this.gate = new Gate(options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
    this.#transactionTimeoutMs =
      options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
    this.root = instance((sql, params, method) =>
      this.#plainQuery(sql, params, method),
    );
  }

  #statement(sql: string): Statement {
    const cached = this.#statements.get(sql);
    if (cached) {
      // Re-insert so the Map's order is least-recently-used first.
      this.#statements.delete(sql);
      this.#statements.set(sql, cached);
      return cached;
    }
    const stmt = this.client.prepare(sql);
    this.#statements.set(sql, stmt);
    if (this.#statements.size > STATEMENT_CACHE_SIZE) {
      const [oldest] = this.#statements.keys();
      this.#statements.get(oldest)?.finalize();
      this.#statements.delete(oldest);
    }
    return stmt;
  }

  /**
   * Row formats drizzle's sqlite-proxy expects: array rows for all/values,
   * a single row (or undefined when there is none) for get, and `{ rows: [] }`
   * for run.
   */
  #exec(
    sql: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Result {
    if (this.#closed) throw new Error("The database is closed");
    const stmt = this.#statement(sql);
    if (method === "run") {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    const rows = stmt.values(...(params as never[])) as Row[];
    return { rows: (method === "get" ? rows[0] : rows) as Result["rows"] };
  }

  async #plainQuery(
    sql: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Promise<Result> {
    // A free gate has no waiters, and the statement below runs to completion
    // before anything else can start, so no ownership is needed.
    if (this.gate.free) return this.#run(sql, params, method);
    const token = new GateToken("query");
    await this.gate.acquire(token);
    try {
      return this.#run(sql, params, method);
    } finally {
      this.gate.release(token);
    }
  }

  #run(
    sql: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Result {
    if (this.client.inTransaction) {
      throw new Error(
        "A query outside any transaction found a transaction open on the connection",
      );
    }
    return this.#exec(sql, params, method);
  }

  async beginTransaction(
    onAbort?: () => void,
    mode: TransactionMode = "write",
  ): Promise<BackendTransaction> {
    const token = new GateToken("transaction", true);
    await this.gate.acquire(token);
    try {
      if (this.client.inTransaction) {
        throw new Error("A transaction is already open on the connection");
      }
      // IMMEDIATE takes the write lock up front, so a transaction that reads
      // and then writes can never fail late with SQLITE_BUSY_SNAPSHOT. A
      // snapshot only reads: the gate keeps every writer of this process out,
      // and the deferred transaction gives it one consistent view.
      this.client.exec(mode === "snapshot" ? "BEGIN" : "BEGIN IMMEDIATE");
    } catch (err) {
      this.gate.release(token);
      throw err;
    }
    const rollbackQuietly = () => {
      if (this.#closed || !this.client.inTransaction) return;
      try {
        this.client.exec("ROLLBACK");
      } catch (err) {
        console.error("rollback failed: %s", describeError(err));
      }
    };
    const watchdog = setTimeout(() => {
      this.#watchdogs.delete(watchdog);
      if (!token.active) return;
      // The stack shows where the transaction was started; it holds code
      // locations only, never query text or values.
      console.error(
        "transaction still open after %dms; rolling it back and releasing the database. Started at:\n%s",
        this.#transactionTimeoutMs,
        token.stack || "(no stack captured)",
      );
      token.active = false;
      onAbort?.();
      rollbackQuietly();
      this.gate.release(token);
    }, this.#transactionTimeoutMs);
    watchdog.unref();
    this.#watchdogs.add(watchdog);

    const owned = <T>(fn: () => T): T => {
      if (!token.active) {
        throw new Error("The transaction has already finished");
      }
      // The engine rolls a transaction back by itself on some errors (a full
      // disk, an I/O failure). Past that point the connection autocommits, so
      // a statement run now would be written outside the transaction.
      if (!this.client.inTransaction) {
        throw new Error(
          "The transaction was rolled back by the database; the statement was not run",
        );
      }
      return fn();
    };
    const db = instance(async (sql, params, method) =>
      owned(() => this.#exec(sql, params, method)),
    );
    const statement = async (text: string) => {
      owned(() => this.client.exec(text));
    };
    return {
      db,
      commit: () => statement("COMMIT"),
      rollback: async () => {
        // Already ended by the watchdog, or by the engine itself.
        if (!token.active) return;
        if (this.client.inTransaction) this.client.exec("ROLLBACK");
      },
      savepoint: (name) => statement(`SAVEPOINT ${name}`),
      releaseSavepoint: (name) => statement(`RELEASE SAVEPOINT ${name}`),
      rollbackToSavepoint: (name) => statement(`ROLLBACK TO SAVEPOINT ${name}`),
      // The gate already runs one transaction at a time.
      lock: async () => {},
      release: () => {
        clearTimeout(watchdog);
        this.#watchdogs.delete(watchdog);
        if (!token.active) return;
        if (this.client.inTransaction) {
          console.error("transaction left open; rolling it back");
          rollbackQuietly();
        }
        this.gate.release(token);
      },
    };
  }

  async migrate(): Promise<void> {
    migrateSqlite(this);
  }

  async withExclusiveClient<T>(
    fn: (client: Database) => T | Promise<T>,
  ): Promise<T> {
    const token = new GateToken("exclusive client", true);
    await this.gate.acquire(token);
    // A body that never settles must not hold the connection for good. A
    // synchronous body blocks the timer as well, so this bounds async ones.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!token.active) return;
        console.error(
          "exclusive client still in use after %dms; releasing the database. Started at:\n%s",
          this.#transactionTimeoutMs,
          token.stack || "(no stack captured)",
        );
        token.active = false;
        this.gate.release(token);
        reject(
          new Error(
            "The exclusive database access was open too long and was released; this work cannot continue",
          ),
        );
      }, this.#transactionTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([Promise.resolve(fn(this.client)), expired]);
    } finally {
      clearTimeout(timer);
      this.gate.release(token);
    }
  }

  resetGate(): void {
    for (const timer of this.#watchdogs) clearTimeout(timer);
    this.#watchdogs.clear();
    this.gate.reset();
    // A transaction that was abandoned mid-way must not leave BEGIN open for
    // whoever uses the connection next.
    if (!this.#closed && this.client.inTransaction) {
      try {
        this.client.exec("ROLLBACK");
      } catch (err) {
        console.error("rollback failed: %s", describeError(err));
      }
    }
  }

  async close(): Promise<void> {
    await this.withExclusiveClient((client) => {
      for (const stmt of this.#statements.values()) stmt.finalize();
      this.#statements.clear();
      this.#closed = true;
      client.close();
    });
  }
}

export function openSqlite(
  path: string,
  options: SqliteOptions = {},
): SqliteBackend {
  const memory = path === ":memory:";
  if (!memory) mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { create: true, strict: true });
  if (!memory) client.exec("PRAGMA journal_mode = WAL;");
  client.exec("PRAGMA foreign_keys = ON;");
  client.exec("PRAGMA busy_timeout = 5000;");
  return new SqliteBackend(client, options);
}

/**
 * Migrations stay on the synchronous bun-sqlite migrator, over a throwaway
 * drizzle instance on the same handle. Runs at startup, before any query.
 */
export function migrateSqlite(backend: SqliteBackend): void {
  if (!backend.gate.free) {
    throw new Error("Cannot migrate while the database is in use");
  }
  migrate(drizzleBun({ client: backend.client }), {
    migrationsFolder: join(process.cwd(), "drizzle", "sqlite"),
  });
}

export type { SqliteBackend };
