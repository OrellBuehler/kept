import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema";

export type DB = ReturnType<typeof drizzle<typeof schema>>;

let db: DB | null = null;

export function openDatabase(path: string): DB {
  const memory = path === ":memory:";
  if (!memory) mkdirSync(dirname(path), { recursive: true });
  const client = new Database(path, { create: true, strict: true });
  if (!memory) client.exec("PRAGMA journal_mode = WAL;");
  client.exec("PRAGMA foreign_keys = ON;");
  client.exec("PRAGMA busy_timeout = 5000;");
  return drizzle({ client, schema });
}

export function migrateDatabase(target: DB): void {
  migrate(target, { migrationsFolder: join(process.cwd(), "drizzle") });
}

export function getDB(): DB {
  if (!db) db = openDatabase(process.env.DATABASE_PATH ?? "./data/kept.db");
  return db;
}

/** Replace the process-wide database. Tests only; pass null to reset. */
export function setDB(next: DB | null): void {
  db = next;
}

/** The first row of a query, or undefined. Select call sites should add `.limit(1)`. */
export async function first<T>(
  query: PromiseLike<T[]>,
): Promise<T | undefined> {
  return (await query)[0];
}

export function runMigrations(): void {
  migrateDatabase(getDB());
}

export * from "./schema";
