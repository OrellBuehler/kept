import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import { describeError } from "$lib/server/errors";
import type { Backend, BackendTransaction, DB } from "./backend";
import { migrateSqlite, openSqlite, type SqliteOptions } from "./sqlite";

export type { DB };
/** What a `transaction()` callback receives; the same type as `getDB()`. */
export type Tx = DB;
export { describeError };

export interface TransactionOptions {
  /**
   * Names a cross-row invariant that the transaction must hold exclusively
   * (for example a last-admin check). SQLite needs nothing: the gate already
   * runs one transaction at a time. Other backends take an advisory lock.
   */
  lock?: string;
}

type Hook = () => void | Promise<void>;

interface TxStore {
  readonly btx: BackendTransaction;
  /** False once the transaction ended, so detached work cannot reuse it. */
  active: boolean;
  hooks: Hook[];
  savepoints: number;
}

const als = new AsyncLocalStorage<TxStore>();
const backends = new WeakMap<object, Backend>();
let current: Backend | null = null;

export function openDatabase(path: string, options?: SqliteOptions): DB {
  const backend = openSqlite(path, options);
  backends.set(backend.root, backend);
  return backend.root;
}

function currentBackend(): Backend {
  current ??= backendOf(
    openDatabase(process.env.DATABASE_PATH ?? "./data/kept.db"),
  );
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
    const store = als.getStore();
    const target: object = store?.active ? store.btx.db : currentBackend().root;
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
  await backend.close();
  if (current === backend) current = null;
}

export function migrateDatabase(target: DB): void {
  migrateSqlite(backendOf(target) as Parameters<typeof migrateSqlite>[0]);
}

export function runMigrations(): void {
  migrateDatabase(getDB());
}

/**
 * Raw access to the connection, for what drizzle cannot express (`VACUUM INTO`
 * backups). The gate is held for the duration, so no query runs meanwhile.
 * Not allowed inside a transaction: it would wait for itself.
 */
export async function withExclusiveClient<T>(
  fn: (client: Database) => T | Promise<T>,
  db: DB = getDB(),
): Promise<T> {
  if (als.getStore()?.active) {
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
 * becomes a savepoint: an error rolls back only the inner work.
 *
 * Keep the body to database work: no network or file I/O, since the whole
 * database waits while it runs. Do side effects with `afterCommit()`.
 */
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  _options: TransactionOptions = {},
): Promise<T> {
  const parent = als.getStore();
  if (parent?.active) return savepoint(parent, fn);

  const btx = await currentBackend().beginTransaction();
  const store: TxStore = { btx, active: true, hooks: [], savepoints: 0 };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const value = await als.run(store, () => fn(btx.db));
    await btx.commit();
    outcome = { ok: true, value };
  } catch (error) {
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
  store.active = false;
  btx.release();
  if (!outcome.ok) throw outcome.error;
  await runHooks(store.hooks);
  return outcome.value;
}

async function savepoint<T>(
  store: TxStore,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const name = `kept_sp_${++store.savepoints}`;
  const mark = store.hooks.length;
  await store.btx.savepoint(name);
  try {
    const value = await fn(store.btx.db);
    await store.btx.releaseSavepoint(name);
    return value;
  } catch (error) {
    store.hooks.length = mark;
    try {
      await store.btx.rollbackToSavepoint(name);
      await store.btx.releaseSavepoint(name);
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
  // Outside the transaction's async context, so hooks never see its store.
  await als.exit(async () => {
    for (const hook of hooks) await runHook(hook);
  });
}

/**
 * Queues `hook` to run once the surrounding transaction has committed and
 * released the connection. It is dropped if the transaction (or the savepoint
 * it was queued in) rolls back. Outside a transaction it runs immediately.
 */
export function afterCommit(hook: Hook): void {
  const store = als.getStore();
  if (store?.active) {
    store.hooks.push(hook);
    return;
  }
  void runHook(hook);
}

/** The first row of a query, or undefined. Select call sites should add `.limit(1)`. */
export async function first<T>(
  query: PromiseLike<T[]>,
): Promise<T | undefined> {
  return (await query)[0];
}

/**
 * True for a unique-constraint violation, however the driver wraps it: the
 * error or any `cause` below it carries SQLITE_CONSTRAINT_UNIQUE (SQLite) or
 * 23505 (PostgreSQL). Check-then-write sequences rely on this instead of an
 * unguarded read followed by a write.
 */
export function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (
    let depth = 0;
    depth < 5 && typeof cursor === "object" && cursor;
    depth++
  ) {
    const code = (cursor as { code?: unknown }).code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export * from "../schema";
