import { afterEach, beforeEach } from "vitest";
import { migrateDatabase, openDatabase, setDB, type DB } from "$lib/server/db";

/**
 * Call once at the top level of a test file (or inside a describe).
 * Every test gets a fresh in-memory database with all migrations applied;
 * `getDB()` in application code returns it. Usage:
 *
 *   const ctx = useTestDB();
 *   it("...", () => { const db = ctx.db; ... });
 */
export function useTestDB(): { readonly db: DB } {
  let current: DB | null = null;
  beforeEach(() => {
    current = openDatabase(":memory:");
    migrateDatabase(current);
    setDB(current);
  });
  afterEach(() => {
    current?.$client.close();
    current = null;
    setDB(null);
  });
  return {
    get db() {
      if (!current) throw new Error("useTestDB: no database outside a test");
      return current;
    },
  };
}
