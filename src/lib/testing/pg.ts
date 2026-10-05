/**
 * PostgreSQL test databases for the `pg` vitest project. No application
 * imports: the global setup runs in the main process, where the schema must
 * not be loaded for the wrong dialect.
 *
 * `kept_template` is created and migrated once per run (global setup); each
 * test file copies it into its own `kept_test_<id>` database, so files run in
 * parallel without sharing rows or locks.
 */

export const TEMPLATE_DB = "kept_template";
export const TEST_DB_PREFIX = "kept_test_";
/** Database named in DATABASE_URL until a file provisions its own, so stray use fails loudly. */
export const UNPROVISIONED_DB = "kept_unprovisioned";

/** Serialises CREATE DATABASE: PostgreSQL refuses to copy a template that is being copied. */
const CREATE_LOCK = 7_265_001;

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function adminUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env.KEPT_TEST_DATABASE_URL?.trim();
  if (!url) throw new Error("KEPT_TEST_DATABASE_URL is not set");
  return url;
}

export function urlFor(database: string, base = adminUrl()): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

function ident(name: string): string {
  if (!NAME.test(name)) throw new Error(`unsafe database name: ${name}`);
  return name;
}

export function newTestDatabaseName(): string {
  return `${TEST_DB_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
}

/** A short-lived admin connection (the maintenance database of the server). */
export async function withAdmin<T>(
  fn: (admin: Bun.SQL) => Promise<T>,
): Promise<T> {
  const admin = new Bun.SQL({
    url: adminUrl(),
    adapter: "postgres",
    max: 1,
    connection: { application_name: "kept-test-admin" },
  });
  try {
    return await fn(admin);
  } finally {
    await admin.close({ timeout: 0 });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** SQLSTATE of a Bun.SQL error. Only the code is read, never the message. */
function sqlState(error: unknown): string | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno;
  return typeof errno === "string" ? errno : undefined;
}

/**
 * Drops the template and every database an earlier, crashed run left behind.
 * Concurrent runs against one server would trample each other here: give each
 * run its own server (the CI service, a throwaway container).
 */
export async function sweepDatabases(): Promise<void> {
  await withAdmin(async (admin) => {
    const rows = (await admin.unsafe(
      "select datname from pg_database where datname = $1 or datname like $2",
      [TEMPLATE_DB, `${TEST_DB_PREFIX}%`],
    )) as { datname: string }[];
    for (const { datname } of rows) {
      await admin.unsafe(
        `alter database ${ident(datname)} with is_template false`,
      );
      await admin.unsafe(
        `drop database if exists ${ident(datname)} with (force)`,
      );
    }
  });
}

/**
 * Creates `name` from the template, retrying while PostgreSQL still counts the
 * template's closing connections (SQLSTATE 55006). The advisory lock is held
 * on one connection for the whole create.
 */
export async function createFromTemplate(name: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe("select pg_advisory_lock($1)", [CREATE_LOCK]);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.unsafe(
            `create database ${ident(name)} template ${TEMPLATE_DB}`,
          );
          return;
        } catch (error) {
          if (sqlState(error) !== "55006" || attempt >= 100) throw error;
          await sleep(50);
        }
      }
    } finally {
      await admin.unsafe("select pg_advisory_unlock($1)", [CREATE_LOCK]);
    }
  });
}

export async function createTemplate(): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe(
      `create database ${TEMPLATE_DB} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`,
    );
  });
}

/** Freezes the migrated template: nothing may connect to it, so it can always be copied. */
export async function sealTemplate(): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe(
      `alter database ${TEMPLATE_DB} with is_template true allow_connections false`,
    );
  });
}

export async function dropDatabase(name: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`);
  });
}

/**
 * The per-file bookkeeping: which database this test file owns, and what to
 * close before dropping it. Module state is per file because vitest isolates
 * the module registry of each test file.
 */
interface FileState {
  name: string;
  url: string;
  /** Empties every application table; set after the first test touched the database. */
  truncate: () => Promise<void>;
  closers: (() => Promise<void>)[];
  dirty: boolean;
}

let file: Promise<FileState> | null = null;

export function fileDatabase(): Promise<FileState> {
  file ??= provision();
  return file;
}

async function provision(): Promise<FileState> {
  const name = newTestDatabaseName();
  await createFromTemplate(name);
  const url = urlFor(name);
  // Anything that reads DATABASE_URL (readDatabaseConfig) now finds this file's database.
  process.env.DATABASE_URL = url;
  // One statement for all tables, built once. The connection is separate from
  // the application pool so a test that leaks a connection cannot block it;
  // the timeout turns a lock a test leaked into an error instead of a hang.
  const maintenance = new Bun.SQL({
    url,
    adapter: "postgres",
    max: 1,
    connection: {
      application_name: "kept-test-truncate",
      statement_timeout: 20_000,
    },
  });
  let statement: string | null = null;
  const state: FileState = {
    name,
    url,
    dirty: false,
    closers: [() => maintenance.close({ timeout: 0 })],
    truncate: async () => {
      statement ??= await truncateStatement(maintenance);
      await maintenance.unsafe(statement);
    },
  };
  return state;
}

async function truncateStatement(client: Bun.SQL): Promise<string> {
  const rows = (await client.unsafe(
    "select quote_ident(tablename) as t from pg_tables where schemaname = 'public' order by tablename",
  )) as { t: string }[];
  if (rows.length === 0) throw new Error("the template database has no tables");
  return `truncate table ${rows.map((r) => `public.${r.t}`).join(", ")} restart identity cascade`;
}

/** Registers something to close before this file's database is dropped. */
export async function onFileDone(close: () => Promise<void>): Promise<void> {
  (await fileDatabase()).closers.unshift(close);
}

/** Closes what the file opened and drops its database. A file that never used the database does nothing. */
export async function finishFile(): Promise<void> {
  if (!file) return;
  const state = await file;
  file = null;
  const failures: unknown[] = [];
  for (const close of state.closers) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  await dropDatabase(state.name);
  if (failures.length > 0) {
    throw new AggregateError(failures, "closing the test database failed");
  }
}
