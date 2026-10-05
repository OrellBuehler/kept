import type { Database } from "bun:sqlite";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from "drizzle-orm";
import { BunSQLDatabase, BunSQLSession } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { join } from "node:path";
import { describeError, safeErrorInfo } from "$lib/server/errors";
import { LedgerError } from "$lib/server/ledger/errors";
import * as schema from "./schema";
import type { Backend, BackendTransaction, DB } from "./backend";
import {
  DEFAULT_PG_TRANSACTION_TIMEOUT_MS,
  type PostgresDatabaseConfig,
} from "./config";

/** Schema holding drizzle's migration history, kept apart from the application tables. */
export const MIGRATIONS_SCHEMA = "drizzle";
/** Key of the session advisory lock that serialises migration runs. */
export const MIGRATION_LOCK_KEY = "kept:migrate";

const tables = extractTablesRelationalConfig(
  schema,
  createTableRelationsHelpers,
);
const relational = {
  fullSchema: schema,
  schema: tables.tables,
  tableNamesMap: tables.tableNamesMap,
};
const dialect = new PgDialect();

/**
 * What the bun-sql driver runs queries on: a pool, or one transaction's
 * connection behind a guard. Only `unsafe` is used by the query builders.
 */
type Queryable = Pick<Bun.SQL, "unsafe">;

/** What `drizzle({ client, schema })` builds, without the per-call schema analysis. */
function instance(client: Queryable): DB {
  const session = new BunSQLSession(
    client as Bun.SQL,
    dialect,
    relational as never,
    {},
  );
  return new BunSQLDatabase(
    dialect,
    session,
    relational as never,
  ) as unknown as DB;
}

/**
 * The connection parameters every pooled connection starts with. Settings sent
 * as startup parameters hold for each connection of the pool, which `SET`
 * would not (it affects one connection only).
 */
function connectionParams(
  config: PostgresDatabaseConfig,
  suffix = "",
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    application_name: `${config.applicationName}${suffix}`.slice(0, 63),
    statement_timeout: config.statementTimeoutMs,
    transaction_timeout: config.transactionTimeoutMs,
  };
  return params;
}

export function createPool(config: PostgresDatabaseConfig): Bun.SQL {
  return new Bun.SQL({
    url: config.url,
    adapter: "postgres",
    max: config.poolMax,
    prepare: config.prepare,
    connection: connectionParams(config),
  });
}

/**
 * Thrown into a transaction callback to make the driver roll back; never
 * reaches the caller.
 */
class RollbackSignal extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

const TIMED_OUT =
  "The transaction was open too long and was rolled back; this work cannot continue";
/** How long the client waits beyond the server's transaction timeout. */
const WATCHDOG_SLACK_MS = 500;

type Ended = { ok: true } | { ok: false; error: unknown };

/**
 * PostgreSQL through Bun.SQL and `drizzle-orm/bun-sql`. Real connections need
 * no gate: plain queries take any pooled connection, and a transaction holds
 * one connection from BEGIN to COMMIT. The facade routes queries made inside a
 * transaction to that connection through its ambient context.
 */
class PostgresBackend implements Backend {
  readonly root: DB;
  #closed = false;

  constructor(
    readonly client: Bun.SQL,
    readonly config: PostgresDatabaseConfig,
    private readonly onClose: () => void = () => {},
  ) {
    this.root = instance(client);
  }

  async beginTransaction(onAbort?: () => void): Promise<BackendTransaction> {
    if (this.#closed) throw new Error("The database is closed");
    // The stack shows where the transaction was started; it holds code
    // locations only, never query text or values.
    const startedAt = new Error("transaction owner").stack ?? "";
    let finish!: (commit: boolean) => void;
    const finishing = new Promise<boolean>((resolve) => (finish = resolve));
    let handOver!: (sql: Bun.TransactionSQL) => void;
    let failedToStart!: (error: unknown) => void;
    const started = new Promise<Bun.TransactionSQL>((resolve, reject) => {
      handOver = resolve;
      failedToStart = reject;
    });
    // `begin` runs BEGIN, the callback, then COMMIT or (when the callback
    // throws) ROLLBACK, and hands the connection back to the pool. The
    // callback here only waits for the facade to say which, so the facade can
    // drive the transaction step by step.
    const ended: Promise<Ended> = this.client
      .begin(async (sql) => {
        handOver(sql);
        if (!(await finishing)) throw new RollbackSignal();
      })
      .then(
        (): Ended => ({ ok: true }),
        (error: unknown): Ended => ({ ok: false, error }),
      );
    void ended.then((result) => {
      // Only matters when BEGIN itself failed: the callback never ran.
      failedToStart(
        result.ok ? new Error("The transaction never started") : result.error,
      );
    });
    const sql = await started;

    let active = true;
    let settled = false;
    let timedOut = false;
    const guarded: Queryable = {
      unsafe: (query, values) => {
        if (!active) throw new Error("The transaction has already finished");
        return sql.unsafe(query, values);
      },
    };
    const raw = async (query: string, values?: unknown[]) => {
      if (!active) throw new Error("The transaction has already finished");
      await sql.unsafe(query, values);
    };
    const end = async (commit: boolean) => {
      if (settled) {
        // A body that outlived the watchdog must not report a commit.
        if (commit && timedOut) throw new Error(TIMED_OUT);
        return;
      }
      settled = true;
      active = false;
      clearTimeout(watchdog);
      finish(commit);
      const result = await ended;
      if (!result.ok && !(result.error instanceof RollbackSignal)) {
        throw result.error;
      }
    };
    // `transaction_timeout` makes the server kill the backend, but the driver
    // keeps counting the pool slot as in use until the callback settles. A
    // body that never settles would leak the slot for good, so the client
    // gives up shortly after the server would have.
    const limit =
      this.config.transactionTimeoutMs > 0
        ? this.config.transactionTimeoutMs + WATCHDOG_SLACK_MS
        : DEFAULT_PG_TRANSACTION_TIMEOUT_MS;
    const watchdog = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      console.error(
        "transaction still open after %dms; abandoning it and freeing its connection. Started at:\n%s",
        limit,
        startedAt || "(no stack captured)",
      );
      onAbort?.();
      end(false).catch((error: unknown) =>
        console.error(
          "rollback after timeout failed: %s",
          describeError(error),
        ),
      );
    }, limit);
    watchdog.unref();
    return {
      db: instance(guarded),
      commit: () => end(true),
      rollback: () => end(false),
      savepoint: (name) => raw(`SAVEPOINT ${name}`),
      releaseSavepoint: (name) => raw(`RELEASE SAVEPOINT ${name}`),
      rollbackToSavepoint: (name) => raw(`ROLLBACK TO SAVEPOINT ${name}`),
      // Session and transaction advisory locks share one key space, so the
      // prefix keeps these apart from the migration lock.
      // Waiting for the lock counts against statement_timeout: a wait longer
      // than that fails with 57014, reported as a conflict the caller can retry.
      lock: (key) =>
        raw("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `kept:tx:${key}`,
        ]).catch((error: unknown) => {
          if (safeErrorInfo(error).sqlState === "57014") {
            throw new LedgerError(
              "conflict",
              "Another change to the same data is still in progress. Try again in a moment.",
            );
          }
          throw error;
        }),
      release: () => {
        if (settled) return;
        // Nobody ended it: roll back so the connection returns clean.
        console.error("transaction left open; rolling it back");
        end(false).catch((error: unknown) =>
          console.error("rollback failed: %s", describeError(error)),
        );
      },
    };
  }

  migrate(): Promise<void> {
    return migratePostgres(this);
  }

  withExclusiveClient<T>(
    _fn: (client: Database) => T | Promise<T>,
  ): Promise<T> {
    return Promise.reject(
      new Error(
        "withExclusiveClient() is only supported on SQLite; back up PostgreSQL with pg_dump or a managed snapshot",
      ),
    );
  }

  resetGate(): void {
    // There is no gate.
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
    await this.client.close({ timeout: 0 });
  }
}

/**
 * The pool of the process-wide database, kept on `globalThis` so a dev server
 * that reloads this module reuses it instead of leaking its connections.
 */
interface SharedPool {
  fingerprint: string;
  client: Bun.SQL;
}
const SHARED = Symbol.for("kept.postgres.pool");
type WithShared = typeof globalThis & { [SHARED]?: SharedPool | null };

function fingerprintOf(config: PostgresDatabaseConfig): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
}

/**
 * Opens a backend on its own pool. With `shared`, the pool is the process-wide
 * one: a second call with the same configuration (a reloaded module) gets the
 * same pool, and closing the backend forgets it.
 */
export function openPostgres(
  config: PostgresDatabaseConfig,
  options: { shared?: boolean } = {},
): PostgresBackend {
  const g = globalThis as WithShared;
  if (!options.shared) return new PostgresBackend(createPool(config), config);
  const fingerprint = fingerprintOf(config);
  const existing = g[SHARED];
  let client: Bun.SQL;
  if (existing && existing.fingerprint === fingerprint) {
    client = existing.client;
  } else {
    if (existing) {
      existing.client
        .close({ timeout: 0 })
        .catch((error: unknown) =>
          console.error(
            "closing the old pool failed: %s",
            describeError(error),
          ),
        );
    }
    client = createPool(config);
    g[SHARED] = { fingerprint, client };
  }
  return new PostgresBackend(client, config, () => {
    if (g[SHARED]?.client === client) g[SHARED] = null;
  });
}

/**
 * Applies the pending migrations. Rolling deploys can overlap, so a session
 * advisory lock on a reserved connection makes concurrent runners take turns
 * (without it the second one fails on the history table's unique key). The
 * lock is released explicitly: a connection that goes back to the pool keeps a
 * session lock. Runs on its own small client, which has no statement or
 * transaction timeout, since a migration may legitimately take long.
 */
export async function migratePostgres(
  backend: PostgresBackend,
  migrationsFolder = join(process.cwd(), "drizzle", "postgres"),
): Promise<void> {
  const { config } = backend;
  const client = new Bun.SQL({
    url: config.url,
    adapter: "postgres",
    max: 2,
    prepare: config.prepare,
    connection: connectionParams(
      { ...config, statementTimeoutMs: 0, transactionTimeoutMs: 0 },
      "-migrate",
    ),
  });
  try {
    const lockConnection = await client.reserve().catch((error: unknown) => {
      // 42704: the server does not know transaction_timeout (older than 17).
      if (safeErrorInfo(error).sqlState === "42704") {
        throw new Error("PostgreSQL 17 or newer is required");
      }
      throw error;
    });
    try {
      await lockConnection.unsafe(
        "select pg_advisory_lock(hashtextextended($1, 0))",
        [MIGRATION_LOCK_KEY],
      );
      try {
        await migrate(
          new BunSQLDatabase(
            dialect,
            new BunSQLSession(client, dialect, relational as never, {}),
            relational as never,
          ),
          { migrationsFolder, migrationsSchema: MIGRATIONS_SCHEMA },
        );
      } finally {
        // A failed unlock must not hide the migration's own error; closing the
        // client below ends the session, which drops the lock anyway.
        await lockConnection
          .unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [
            MIGRATION_LOCK_KEY,
          ])
          .catch((error: unknown) =>
            console.error(
              "releasing the migration lock failed: %s",
              describeError(error),
            ),
          );
      }
    } finally {
      lockConnection.release();
    }
  } finally {
    await client.close({ timeout: 0 });
  }
}

export type { PostgresBackend };
