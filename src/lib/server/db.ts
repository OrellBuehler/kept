import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let db: DB | null = null;

export function getDB(): DB {
  if (!db) {
    const path = process.env.DATABASE_PATH ?? "./data/kept.db";
    mkdirSync(dirname(path), { recursive: true });
    const client = new Database(path, { create: true, strict: true });
    client.exec("PRAGMA journal_mode = WAL;");
    client.exec("PRAGMA foreign_keys = ON;");
    client.exec("PRAGMA busy_timeout = 5000;");
    db = drizzle({ client, schema });
  }
  return db;
}

export function runMigrations(): void {
  migrate(getDB(), { migrationsFolder: join(process.cwd(), "drizzle") });
}

export * from "./schema";
