import { afterEach, beforeEach } from "vitest";
import {
  closeDatabase,
  getDB,
  migrateDatabase,
  openDatabase,
  openPostgresDatabase,
  setDB,
  type DB,
} from "$lib/server/db";
import { readDatabaseConfig } from "$lib/server/db/config";
import { dialect } from "$lib/server/db/dialect";
import { fileDatabase, onFileDone } from "./pg";

/**
 * Call once at the top level of a test file (or inside a describe).
 * Every test gets an empty database with all migrations applied;
 * `getDB()` in application code returns it. Usage:
 *
 *   const ctx = useTestDB();
 *   it("...", async () => { const db = ctx.db; ... });
 *
 * `ctx.db` is the same ambient object as `getDB()`, so it joins a transaction
 * when used inside one.
 *
 * SQLite: a fresh in-memory database per test. PostgreSQL (the `pg` vitest
 * project): one database per test file, copied from the migrated template on
 * first use and truncated before each later test; the pool lives until the
 * file ends (src/lib/testing/pg.ts).
 */
export function useTestDB(): { readonly db: DB } {
  let current: DB | null = null;
  beforeEach(async () => {
    current = dialect === "pg" ? await postgresFor() : await sqlite();
    setDB(current);
  });
  afterEach(async () => {
    const opened = current;
    current = null;
    if (dialect === "sqlite") {
      if (opened) await closeDatabase(opened);
    }
    setDB(null);
  });
  return {
    get db() {
      if (!current) throw new Error("useTestDB: no database outside a test");
      return getDB();
    },
  };
}

async function sqlite(): Promise<DB> {
  const db = openDatabase(":memory:");
  await migrateDatabase(db);
  return db;
}

let pool: Promise<DB> | null = null;
let used = false;

async function postgresFor(): Promise<DB> {
  const file = await fileDatabase();
  pool ??= open(file.url);
  const db = await pool;
  if (used) await file.truncate();
  used = true;
  return db;
}

async function open(url: string): Promise<DB> {
  const config = readDatabaseConfig({
    DATABASE_URL: url,
    // Each file holds only a few connections; the machine runs many files at once.
    KEPT_DB_POOL_MAX: "3",
    KEPT_DB_APPLICATION_NAME: "kept-test",
  });
  if (config.kind !== "postgres") throw new Error("expected a postgres config");
  const db = openPostgresDatabase(config);
  await onFileDone(async () => {
    setDB(null);
    await closeDatabase(db);
    pool = null;
    used = false;
  });
  return db;
}
