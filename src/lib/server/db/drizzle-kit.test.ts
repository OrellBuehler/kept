import {
  generateDrizzleJson,
  generateMigration,
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from "drizzle-kit/api";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Schema = typeof import("./schema");

async function load(databaseUrl: string): Promise<Schema> {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", databaseUrl);
  return import("./schema");
}

afterEach(() => vi.unstubAllEnvs());

const sqliteDir = join(process.cwd(), "drizzle", "sqlite", "meta");

/** The newest snapshot drizzle-kit wrote for SQLite. */
function latestSqliteSnapshot() {
  const { entries } = JSON.parse(
    readFileSync(join(sqliteDir, "_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  const last = entries[entries.length - 1].idx;
  const name = `${String(last).padStart(4, "0")}_snapshot.json`;
  return JSON.parse(readFileSync(join(sqliteDir, name), "utf8"));
}

describe("drizzle-kit (what `drizzle-kit generate` would do)", () => {
  it("sees no change between the SQLite schema and the committed migrations", async () => {
    const schema = await load("");
    const previous = latestSqliteSnapshot();
    const current = await generateSQLiteDrizzleJson(schema, previous.id);
    expect(await generateSQLiteMigration(previous, current)).toEqual([]);
  });

  it("does see a change when the schema differs from the snapshot", async () => {
    const schema = await load("");
    const previous = latestSqliteSnapshot();
    delete previous.tables.sessions.indexes.sessions_user_id_idx;
    const current = await generateSQLiteDrizzleJson(schema, previous.id);
    const statements = await generateSQLiteMigration(previous, current);
    expect(statements.join("\n")).toContain("sessions_user_id_idx");
  });

  it("generates a PostgreSQL baseline from the same schema", async () => {
    const schema = await load("postgres://example.invalid/kept");
    const empty = await generateDrizzleJson({});
    const current = await generateDrizzleJson(schema, empty.id);
    const sql = (await generateMigration(empty, current)).join("\n");

    expect(sql.match(/CREATE TABLE/g)?.length).toBeGreaterThan(40);
    expect(sql).toContain(
      '"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL',
    );
    expect(sql).toContain('"opening_balance" bigint');
    expect(sql).toContain('"bill_source" json');
    expect(sql).toContain('"logo" "bytea"');
    expect(sql).toContain('"archived" boolean');
    expect(sql).toContain("paperless_report_uploads_connection_id_fk");
    expect(sql).toContain("pillar_3a_buy_in_years_contribution_id_fk");
    expect(sql).not.toContain("unixepoch");
    expect(sql).not.toMatch(/integer/i);

    expect(await generateMigration(current, current)).toEqual([]);
  });
});
