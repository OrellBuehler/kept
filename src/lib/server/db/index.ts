import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import { describeError } from "$lib/server/errors";
import type { Backend, BackendTransaction, DB } from "./backend";
import { readDatabaseConfig, type PostgresDatabaseConfig } from "./config";
import { dialect } from "./dialect";
import { openPostgres } from "./postgres";
import { openSqlite, type SqliteOptions } from "./sqlite";

export type { DB };
/** What a `transaction()` callback receives; the same type as `getDB()`. */
export type Tx = DB;
export { describeError };

export interface TransactionOptions {
  /**
   * Names a cross-row invariant that the transaction must hold exclusively
   * (for example a last-admin check). SQLite needs nothing: the gate already
   * runs one transaction at a time. PostgreSQL takes a transaction-scoped
   * advisory lock on the key, which is only sound under READ COMMITTED (the
   * default, and the only level the facade uses). Keys are free-form text.
   */
  lock?: string;
}

type Hook = () => void | Promise<void>;

/**
 * What the transaction as a whole is doing. `finished` is set before the
 * COMMIT is issued, `aborted` before the ROLLBACK, so no ambient statement can
 * reach the owned connection once ending has begun.
 */
type TxState = "active" | "finished" | "aborted";

interface Tx0 {
  readonly btx: BackendTransaction;
  state: TxState;
  savepoints: number;
}

/**
 * One level of nesting: the transaction body itself, or one savepoint. The
 * async context carries a frame, so concurrent savepoints started from the
 * same level each keep their own hooks, and a savepoint's own nested
 * transactions lock only that savepoint.
 */
interface Frame {
  readonly tx: Tx0;
  readonly parent: Frame | null;
  hooks: Hook[];
  /** `open` while the body runs; the others once the savepoint ended. */
  status: "open" | "released" | "rolledBack";
  /** Tail of the queue of savepoints started directly from this frame. */
  lock: Promise<void>;
}

function newFrame(tx: Tx0, parent: Frame | null): Frame {
  return {
    tx,
    parent,
    hooks: [],
    status: "open",
    lock: Promise.resolve(),
  };
}

const ROLLED_BACK =
  "The transaction was rolled back; this work cannot continue";

/**
 * Where work running in `frame` goes: into the transaction, or (once it
 * committed, or outside any) to the shared connection. Work that belongs to a
 * transaction or savepoint that was rolled back must not write anything.
 */
function classify(frame: Frame | undefined): "tx" | "root" | "rolledBack" {
  if (!frame) return "root";
  for (let f: Frame | null = frame; f; f = f.parent) {
    if (f.status === "rolledBack") return "rolledBack";
  }
  if (frame.tx.state === "aborted") return "rolledBack";
  return frame.tx.state === "active" ? "tx" : "root";
}

function route(frame: Frame | undefined): "tx" | "root" {
  const where = classify(frame);
  if (where === "rolledBack") throw new Error(ROLLED_BACK);
  return where;
}

/** The nearest frame that still collects hooks. */
function hookTarget(frame: Frame): Frame {
  let f = frame;
  while (f.status !== "open" && f.parent) f = f.parent;
  return f;
}

const als = new AsyncLocalStorage<Frame>();
const backends = new WeakMap<object, Backend>();
let current: Backend | null = null;

export function openDatabase(path: string, options?: SqliteOptions): DB {
  // The schema is built for the resolved dialect; opening SQLite under a
  // PostgreSQL schema would write PostgreSQL defaults into SQLite columns.
  // The process-wide database picks its backend in currentBackend().
  if (dialect !== "sqlite") {
    throw new Error(
      "openDatabase() opens SQLite, but DATABASE_URL selects PostgreSQL; use openPostgresDatabase()",
    );
  }
  const backend = openSqlite(path, options);
  backends.set(backend.root, backend);
  return backend.root;
}

/**
 * Opens a PostgreSQL database on its own pool. The process-wide database goes
 * through `currentBackend()` instead, which shares its pool across reloads of
 * this module in dev.
 */
export function openPostgresDatabase(config: PostgresDatabaseConfig): DB {
  const backend = openPostgres(config);
  backends.set(backend.root, backend);
  return backend.root;
}

function currentBackend(): Backend {
  if (current) return current;
  const config = readDatabaseConfig();
  if (config.kind === "postgres") {
    const backend = openPostgres(config, { shared: true });
    backends.set(backend.root, backend);
    current = backend;
  } else {
    current = backendOf(openDatabase(config.path));
  }
  return current;
}

function backendOf(db: DB): Backend {
  const backend = backends.get(db === ambient ? currentBackend().root : db);
  if (!backend) throw new Error("Not a database opened by openDatabase()");
  return backend;
}

/**
 * The database for the code running right now: the open transaction when
 * called inside `transaction()`, otherwise the shared connection. It is a
 * stable object that resolves on every property access, so a `db` captured
 * before a transaction started still joins it.
 */
const ambient = new Proxy({} as DB, {
  get(_target, prop) {
    if (prop === "transaction" || prop === "batch") {
      throw new Error(
        `db.${String(prop)}() is not available: use transaction() from $lib/server/db`,
      );
    }
    const frame = als.getStore();
    const target: object =
      route(frame) === "tx" ? frame!.tx.btx.db : currentBackend().root;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export function getDB(): DB {
  return ambient;
}

/**
 * Replace the process-wide database. Tests only; pass null to reset. The new
 * database starts with a clean gate, so a test that left something stuck
 * cannot hang the ones after it.
 */
export function setDB(next: DB | null): void {
  if (next === null) {
    current = null;
    return;
  }
  const backend = backends.get(next);
  if (!backend) throw new Error("Not a database opened by openDatabase()");
  backend.resetGate();
  current = backend;
}

/** Closes a database once nothing else is using it. Tests only. */
export async function closeDatabase(db: DB): Promise<void> {
  const backend = backendOf(db);
  // Closing waits for the connection; a transaction that leaked must not make
  // it wait out the gate timeout.
  backend.resetGate();
  await backend.close();
  if (current === backend) current = null;
}

export async function migrateDatabase(target: DB): Promise<void> {
  await backendOf(target).migrate();
}

export async function runMigrations(): Promise<void> {
  await migrateDatabase(getDB());
}

/**
 * Raw access to the connection, for what drizzle cannot express (`VACUUM INTO`
 * backups). The gate is held for the duration, so no query runs meanwhile.
 * Not allowed inside a transaction: it would wait for itself. SQLite only: on
 * PostgreSQL it rejects (use `pg_dump` or a managed snapshot for backups).
 */
export async function withExclusiveClient<T>(
  fn: (client: Database) => T | Promise<T>,
  db: DB = getDB(),
): Promise<T> {
  if (als.getStore()?.tx.state === "active") {
    throw new Error(
      "withExclusiveClient() cannot be used inside a transaction",
    );
  }
  return backendOf(db).withExclusiveClient(fn);
}

/**
 * Runs `fn` in a transaction and commits when it resolves, rolls back (and
 * rethrows the original error) when it throws. `getDB()` inside `fn` and
 * everything it awaits resolves to `tx`. Called inside another transaction it
 * becomes a savepoint: an error rolls back only the inner work. Savepoints
 * started side by side run one after the other.
 *
 * Keep the body to database work: no network or file I/O, since the whole
 * database waits while it runs. Do side effects with `afterCommit()`. Never
 * await a promise or query builder that was created outside this transaction
 * from inside it: if it needs the database it waits behind this transaction,
 * which waits for it, until the gate timeout. Work that is still running when
 * the transaction rolls back fails instead of writing outside it.
 */
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const parent = als.getStore();
  if (parent && route(parent) === "tx") {
    return savepoint(parent, fn, options.lock);
  }

  const btx = await currentBackend().beginTransaction();
  const tx: Tx0 = { btx, state: "active", savepoints: 0 };
  const frame = newFrame(tx, null);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    if (options.lock !== undefined) await btx.lock(options.lock);
    const value = await als.run(frame, () => fn(btx.db));
    tx.state = "finished";
    await btx.commit();
    outcome = { ok: true, value };
  } catch (error) {
    tx.state = "aborted";
    outcome = { ok: false, error };
    try {
      await btx.rollback();
    } catch (rollbackError) {
      // Never let a failing rollback hide the error that caused it.
      console.error(
        "transaction rollback failed: %s",
        describeError(rollbackError),
      );
    }
  }
  btx.release();
  if (!outcome.ok) throw outcome.error;
  await runHooks(frame.hooks);
  return outcome.value;
}

async function savepoint<T>(
  parent: Frame,
  fn: (tx: Tx) => Promise<T>,
  lock: string | undefined,
): Promise<T> {
  // Siblings queue here, so two savepoints never overlap on the connection:
  // SQLite would undo the earlier one's work along with the later one's.
  const turn = parent.lock;
  let done!: () => void;
  parent.lock = new Promise<void>((resolve) => (done = resolve));
  try {
    await turn;
    return await runSavepoint(parent, fn, lock);
  } finally {
    done();
  }
}

async function runSavepoint<T>(
  parent: Frame,
  fn: (tx: Tx) => Promise<T>,
  lock: string | undefined,
): Promise<T> {
  const { tx } = parent;
  if (tx.state === "finished") {
    throw new Error("The transaction has already finished");
  }
  if (route(parent) !== "tx") throw new Error(ROLLED_BACK);
  const name = `kept_sp_${++tx.savepoints}`;
  const frame = newFrame(tx, parent);
  await tx.btx.savepoint(name);
  try {
    // Held until the outer transaction ends, which is what a lock taken by a
    // nested call must do.
    if (lock !== undefined) await tx.btx.lock(lock);
    const value = await als.run(frame, () => fn(tx.btx.db));
    frame.status = "released";
    await tx.btx.releaseSavepoint(name);
    hookTarget(parent).hooks.push(...frame.hooks);
    return value;
  } catch (error) {
    frame.status = "rolledBack";
    try {
      await tx.btx.rollbackToSavepoint(name);
      await tx.btx.releaseSavepoint(name);
    } catch (rollbackError) {
      console.error(
        "savepoint rollback failed: %s",
        describeError(rollbackError),
      );
    }
    throw error;
  }
}

async function runHook(hook: Hook): Promise<void> {
  try {
    await hook();
  } catch (error) {
    // The change is committed; a failing side effect must not undo that.
    console.error("after-commit hook failed: %s", describeError(error));
  }
}

async function runHooks(hooks: Hook[]): Promise<void> {
  if (hooks.length === 0) return;
  // Outside the transaction's async context, so hooks never see its frame.
  await als.exit(async () => {
    for (const hook of hooks) await runHook(hook);
  });
}

/**
 * Queues `hook` to run once the surrounding transaction has committed and
 * released the connection. It is dropped if the transaction (or the savepoint
 * it was queued in) rolls back. Outside a transaction it runs immediately.
 *
 * The hooks are awaited before `transaction()` returns, so keep them short;
 * slow I/O belongs in a detached task that the hook starts.
 */
export function afterCommit(hook: Hook): void {
  const frame = als.getStore();
  const where = classify(frame);
  if (where === "tx") hookTarget(frame!).hooks.push(hook);
  // Work that outlived a rollback must not announce a commit that never was.
  else if (where === "root") void runHook(hook);
}

/** The first row of a query, or undefined. Select call sites should add `.limit(1)`. */
export async function first<T>(
  query: PromiseLike<T[]>,
): Promise<T | undefined> {
  return (await query)[0];
}

const UNIQUE_CODES = new Set([
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "23505",
]);

/**
 * True for a unique-constraint violation, however the driver wraps it: the
 * error or any `cause` below it carries SQLITE_CONSTRAINT_UNIQUE or
 * SQLITE_CONSTRAINT_PRIMARYKEY (SQLite), or SQLSTATE 23505 (PostgreSQL: in
 * `code` for most drivers, in `errno` for Bun's). Check-then-write sequences
 * rely on this instead of an unguarded read followed by a write.
 */
export function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (
    let depth = 0;
    depth < 5 && typeof cursor === "object" && cursor;
    depth++
  ) {
    const { code, errno, cause } = cursor as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && UNIQUE_CODES.has(code)) return true;
    if (errno === "23505") return true;
    cursor = cause;
  }
  return false;
}

/**
 * Which unique constraint was violated. PostgreSQL names the constraint (the
 * unique index's name); SQLite names the columns in its message.
 */
export interface UniqueTarget {
  /** The unique index name, as given in the schema (PostgreSQL). */
  constraint: string;
  table: string;
  /** The indexed columns in index order (SQLite). */
  columns: readonly string[];
}

/**
 * True when `err` is a violation of that specific unique constraint, however
 * the driver wraps it. Reads `message` and `constraint` only to compare them,
 * never to log.
 */
export function isUniqueViolationOn(
  err: unknown,
  target: UniqueTarget,
): boolean {
  const sqliteMessage = `UNIQUE constraint failed: ${target.columns
    .map((c) => `${target.table}.${c}`)
    .join(", ")}`;
  let cursor: unknown = err;
  for (
    let depth = 0;
    depth < 5 && typeof cursor === "object" && cursor;
    depth++
  ) {
    const { errno, constraint, message, cause } = cursor as {
      errno?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (errno === "23505" && constraint === target.constraint) return true;
    if (message === sqliteMessage) return true;
    cursor = cause;
  }
  return false;
}

export { alias } from "./columns";
export { escapeLike, likeContains } from "./search";
export * from "./schema";
