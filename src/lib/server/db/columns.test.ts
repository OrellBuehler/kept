import { getTableColumns, is, sql } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";

type Columns = typeof import("./columns");

async function load(databaseUrl?: string): Promise<Columns> {
  vi.resetModules();
  if (databaseUrl === undefined) vi.stubEnv("DATABASE_URL", "");
  else vi.stubEnv("DATABASE_URL", databaseUrl);
  return import("./columns");
}

afterEach(() => vi.unstubAllEnvs());

const render = (chunk: ReturnType<typeof sql>) =>
  new PgDialect().sqlToQuery(chunk);

describe("sqlite builders", () => {
  it("build genuine sqlite tables and columns", async () => {
    const c = await load();
    const t = c.table("t", {
      id: c.text("id").primaryKey(),
      at: c.instant("at").notNull(),
      n: c.int("n"),
      m: c.minor("m"),
      f: c.fixed("f"),
      b: c.bool("b"),
      j: c.json<{ a: number }>("j"),
      raw: c.bytes("raw"),
      ...c.timestamps(),
    });
    expect(is(t, SQLiteTable)).toBe(true);
    const cols = getTableColumns(t);
    expect(cols.at.getSQLType()).toBe("integer");
    expect(cols.n.getSQLType()).toBe("integer");
    expect(cols.m.getSQLType()).toBe("integer");
    expect(cols.b.getSQLType()).toBe("integer");
    expect(cols.j.getSQLType()).toBe("text");
    expect(cols.raw.getSQLType()).toBe("blob");
    expect(cols.at.mapFromDriverValue(1_700_000_000_123)).toEqual(
      new Date(1_700_000_000_123),
    );
    expect(cols.b.mapFromDriverValue(1)).toBe(true);
    expect(cols.j.mapToDriverValue({ a: 1 })).toBe('{"a":1}');
  });

  it("keeps the timestamp default byte-identical to the migrations", async () => {
    const c = await load();
    const t = c.table("t", { ...c.timestamps() });
    const cols = getTableColumns(t);
    expect(cols.createdAt.default).toBeDefined();
    const query = new PgDialect().sqlToQuery(cols.createdAt.default as never);
    expect(query.sql).toBe("(unixepoch('subsec') * 1000)");
    expect(cols.updatedAt.onUpdateFn).toBeTypeOf("function");
  });

  it("treats a non-postgres DATABASE_URL as sqlite", async () => {
    const c = await load("./data/other.db");
    expect(is(c.table("t", { id: c.text("id") }), SQLiteTable)).toBe(true);
  });
});

describe("postgres builders", () => {
  it("build genuine pg tables and columns", async () => {
    const c = await load("postgres://example.invalid/kept");
    const t = c.table("t", {
      id: c.text("id").primaryKey(),
      at: c.instant("at").notNull(),
      n: c.int("n"),
      m: c.minor("m"),
      f: c.fixed("f"),
      b: c.bool("b"),
      j: c.json<{ a: number }>("j"),
      raw: c.bytes("raw"),
      ...c.timestamps(),
    });
    expect(is(t, PgTable)).toBe(true);
    const cols = getTableColumns(t);
    expect(cols.at.getSQLType()).toBe("timestamp (3) with time zone");
    expect(cols.n.getSQLType()).toBe("bigint");
    expect(cols.m.getSQLType()).toBe("bigint");
    expect(cols.f.getSQLType()).toBe("bigint");
    expect(cols.b.getSQLType()).toBe("boolean");
    expect(cols.j.getSQLType()).toBe("json");
    expect(cols.raw.getSQLType()).toBe("bytea");
    expect(getTableConfig(t).name).toBe("t");
  });

  it("returns bigint columns as numbers", async () => {
    const c = await load("postgres://example.invalid/kept");
    const col = getTableColumns(c.table("t", { n: c.int("n") })).n;
    expect(col.mapFromDriverValue("9007199254740991")).toBe(9007199254740991);
    expect(col.mapFromDriverValue("-5")).toBe(-5);
  });

  it("defaults timestamps to clock_timestamp()", async () => {
    const c = await load("postgres://example.invalid/kept");
    const cols = getTableColumns(c.table("t", { ...c.timestamps() }));
    expect(render(cols.createdAt.default as never).sql).toBe(
      "clock_timestamp()",
    );
    expect(render(cols.updatedAt.default as never).sql).toBe(
      "clock_timestamp()",
    );
  });

  it("never combines a default with a default function on a timestamp", async () => {
    const c = await load("postgres://example.invalid/kept");
    for (const col of Object.values(
      getTableColumns(c.table("t", { ...c.timestamps() })),
    )) {
      expect(col.defaultFn).toBeUndefined();
    }
  });

  it("writes json through text so the document is stored, not a string", async () => {
    const c = await load("postgres://example.invalid/kept");
    const col = getTableColumns(c.table("t", { j: c.json<unknown>("j") })).j;
    for (const value of [{ a: 1 }, [1, 2], "hello", 7, true, null]) {
      const query = render(col.mapToDriverValue(value) as never);
      expect(query.sql).toBe("$1::text::json");
      expect(query.params).toEqual([JSON.stringify(value)]);
    }
  });

  it("reads json as the driver parsed it", async () => {
    const c = await load("postgres://example.invalid/kept");
    const col = getTableColumns(c.table("t", { j: c.json<unknown>("j") })).j;
    expect(col.mapFromDriverValue({ a: 1 })).toEqual({ a: 1 });
    expect(col.mapFromDriverValue("hello")).toBe("hello");
    expect(col.mapFromDriverValue(false)).toBe(false);
  });

  it("reads bytea from a Buffer, a Uint8Array or hex text", async () => {
    const c = await load("postgres://example.invalid/kept");
    const col = getTableColumns(c.table("t", { raw: c.bytes("raw") })).raw;
    const want = Buffer.from([0, 1, 254, 255]);
    const fromBuffer = col.mapFromDriverValue(want);
    expect(fromBuffer).toBe(want);
    const fromView = col.mapFromDriverValue(
      new Uint8Array([9, 0, 1, 254, 255, 9]).subarray(1, 5),
    ) as Buffer;
    expect(Buffer.isBuffer(fromView)).toBe(true);
    expect(fromView.equals(want)).toBe(true);
    expect((col.mapFromDriverValue("\\x0001feff") as Buffer).equals(want)).toBe(
      true,
    );
    expect((col.mapFromDriverValue("0001feff") as Buffer).equals(want)).toBe(
      true,
    );
    expect((col.mapFromDriverValue("\\x") as Buffer).length).toBe(0);
    expect(() => col.mapFromDriverValue(42 as never)).toThrow(TypeError);
  });

  it("passes bytes through on write", async () => {
    const c = await load("postgres://example.invalid/kept");
    const col = getTableColumns(c.table("t", { raw: c.bytes("raw") })).raw;
    const value = Buffer.from([1, 2, 3]);
    expect(col.mapToDriverValue(value)).toBe(value);
  });
});
