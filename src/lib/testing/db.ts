import { afterEach, beforeEach } from "vitest";
import {
  closeDatabase,
  getDB,
  migrateDatabase,
  openDatabase,
  setDB,
  type DB,
} from "$lib/server/db";

/**
 * Call once at the top level of a test file (or inside a describe).
 * Every test gets a fresh in-memory database with all migrations applied;
 * `getDB()` in application code returns it. Usage:
 *
 *   const ctx = useTestDB();
 *   it("...", async () => { const db = ctx.db; ... });
 *
 * `ctx.db` is the same ambient object as `getDB()`, so it joins a transaction
 * when used inside one.
 */
export function useTestDB(): { readonly db: DB } {
  let current: DB | null = null;
  beforeEach(async () => {
    current = openDatabase(":memory:");
    await migrateDatabase(current);
    setDB(current);
  });
  afterEach(async () => {
    const opened = current;
    current = null;
    if (opened) await closeDatabase(opened);
    setDB(null);
  });
  return {
    get db() {
      if (!current) throw new Error("useTestDB: no database outside a test");
      return getDB();
    },
  };
}
