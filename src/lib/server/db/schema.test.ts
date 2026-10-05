import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRIZZLE_KIT_PIN_ENV } from "./dialect";

type Schema = typeof import("./schema");

async function load(env: Record<string, string>): Promise<Schema> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("./schema");
}

afterEach(() => vi.unstubAllEnvs());

const tablesOf = (schema: Schema): Table[] =>
  Object.values(schema).filter((value) => is(value, Table)) as Table[];

const PG = { DATABASE_URL: "postgres://example.invalid/kept" };
const SQLITE = { DATABASE_URL: "" };

describe("schema", () => {
  it("builds the same tables and columns on both dialects", async () => {
    const sqlite = tablesOf(await load(SQLITE));
    const pg = tablesOf(await load(PG));
    expect(sqlite.length).toBeGreaterThan(30);
    expect(sqlite.every((t) => is(t, SQLiteTable))).toBe(true);
    expect(pg.every((t) => is(t, PgTable))).toBe(true);
    const shape = (tables: Table[]) =>
      Object.fromEntries(
        tables.map((t) => [
          getTableName(t),
          Object.values(getTableColumns(t))
            .map((c) => c.name)
            .sort(),
        ]),
      );
    expect(shape(pg)).toEqual(shape(sqlite));
  });

  it.each([
    ["sqlite", SQLITE],
    ["pg", PG],
  ])("never combines .default() with $defaultFn (%s)", async (_, env) => {
    const offenders = tablesOf(await load(env)).flatMap((t) =>
      Object.values(getTableColumns(t))
        .filter((c) => c.default !== undefined && c.defaultFn !== undefined)
        .map((c) => `${getTableName(t)}.${c.name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every PostgreSQL identifier within 63 bytes", async () => {
    const identifiers = tablesOf(await load(PG)).flatMap((t) => {
      const config = getTableConfig(t as PgTable);
      return [
        config.name,
        ...config.columns.map((c) => c.name),
        ...config.foreignKeys.map((fk) => fk.getName()),
        ...config.indexes.map((i) => i.config.name ?? ""),
        ...config.uniqueConstraints.map((u) => u.getName() ?? ""),
        `${config.name}_pkey`,
      ];
    });
    expect(identifiers.length).toBeGreaterThan(200);
    expect(identifiers.filter((name) => Buffer.byteLength(name) > 63)).toEqual(
      [],
    );
  });

  it("names the two over-long foreign keys explicitly on PostgreSQL only", async () => {
    const names = async (env: Record<string, string>, table: string) => {
      const schema = await load(env);
      const t = tablesOf(schema).find((x) => getTableName(x) === table)!;
      const fks = is(t, PgTable)
        ? getTableConfig(t).foreignKeys
        : getSqliteTableConfig(t as SQLiteTable).foreignKeys;
      return fks.map((fk) => fk.getName());
    };
    expect(await names(PG, "paperless_report_uploads")).toContain(
      "paperless_report_uploads_connection_id_fk",
    );
    expect(await names(PG, "pillar_3a_buy_in_years")).toContain(
      "pillar_3a_buy_in_years_contribution_id_fk",
    );
    // SQLite keeps drizzle's generated names: they are in the migration history.
    expect(await names(SQLITE, "paperless_report_uploads")).toContain(
      "paperless_report_uploads_connection_id_paperless_connections_id_fk",
    );
    expect(await names(SQLITE, "pillar_3a_buy_in_years")).toContain(
      "pillar_3a_buy_in_years_contribution_id_pillar_3a_contributions_id_fk",
    );
  });

  it("throws when the drizzle-kit pin disagrees with the resolved dialect", async () => {
    await expect(
      load({ ...SQLITE, [DRIZZLE_KIT_PIN_ENV]: "pg" }),
    ).rejects.toThrow(/generating for "pg".*resolved to "sqlite"/);
    await expect(
      load({ ...PG, [DRIZZLE_KIT_PIN_ENV]: "sqlite" }),
    ).rejects.toThrow(/generating for "sqlite".*resolved to "pg"/);
  });

  it("loads when the pin agrees", async () => {
    expect(
      tablesOf(await load({ ...PG, [DRIZZLE_KIT_PIN_ENV]: "pg" })).length,
    ).toBeGreaterThan(30);
    expect(
      tablesOf(await load({ ...SQLITE, [DRIZZLE_KIT_PIN_ENV]: "sqlite" }))
        .length,
    ).toBeGreaterThan(30);
  });
});
