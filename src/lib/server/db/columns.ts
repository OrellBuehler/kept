/**
 * Dialect-switched schema builders. The schema is written once, against these,
 * and typed as drizzle's pg-core: at runtime the process holds genuine sqlite
 * or genuine pg tables (drizzle's `is()` compares entity kinds), so nothing
 * here may be called by name outside the schema, and the pg-only API surface
 * the types would allow is banned by lint.
 *
 * No `bun:*` imports: drizzle-kit loads this under Node.
 */
import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import * as sqlite from "drizzle-orm/sqlite-core";
import type { Minor } from "$lib/money";
import type { Fixed8 } from "$lib/quantity";
import { dialect } from "./dialect";

const isPg = dialect === "pg";

export const table = (
  isPg ? pg.pgTable : sqlite.sqliteTable
) as typeof pg.pgTable;
export const text = (isPg ? pg.text : sqlite.text) as typeof pg.text;
export const index = (isPg ? pg.index : sqlite.index) as typeof pg.index;
export const uniqueIndex = (
  isPg ? pg.uniqueIndex : sqlite.uniqueIndex
) as typeof pg.uniqueIndex;
export const foreignKey = (
  isPg ? pg.foreignKey : sqlite.foreignKey
) as typeof pg.foreignKey;

const pgInstant = (name: string) =>
  pg.timestamp(name, { precision: 3, withTimezone: true, mode: "date" });
const pgInt = (name: string) => pg.bigint(name, { mode: "number" });
const pgBool = (name: string) => pg.boolean(name);

/** An instant: `timestamp(3) with time zone` on PostgreSQL, epoch milliseconds on SQLite. */
export const instant = (name: string): ReturnType<typeof pgInstant> =>
  (isPg
    ? pgInstant(name)
    : sqlite.integer(name, {
        mode: "timestamp_ms",
      })) as unknown as ReturnType<typeof pgInstant>;

/**
 * A 64-bit integer: `bigint` on PostgreSQL (many columns exceed int4: epoch
 * milliseconds, money, scaled quantities), `integer` on SQLite. PostgreSQL
 * reads come back as numbers; aggregates over them need `.mapWith(Number)`.
 */
export const int = (name: string): ReturnType<typeof pgInt> =>
  (isPg ? pgInt(name) : sqlite.integer(name)) as unknown as ReturnType<
    typeof pgInt
  >;

/** An amount in minor units (see money.ts). */
export const minor = (name: string) => int(name).$type<Minor>();

/** An integer scaled by 1e8 (see quantity.ts). */
export const fixed = (name: string) => int(name).$type<Fixed8>();

export const bool = (name: string): ReturnType<typeof pgBool> =>
  (isPg
    ? pgBool(name)
    : sqlite.integer(name, { mode: "boolean" })) as unknown as ReturnType<
    typeof pgBool
  >;

function pgJson<T>(name: string) {
  return pg.customType<{ data: T; driverData: unknown }>({
    dataType: () => "json",
    // drizzle's own json() hands the string to the driver, which stores it as a
    // JSON string value. Casting through text stores the document itself.
    toDriver: (value) => sql`${JSON.stringify(value)}::text::json`,
    // The driver has already parsed the document; parsing again would throw on
    // a legitimate top-level string.
    fromDriver: (value) => value as T,
  })(name);
}

/** A JSON document: `json` on PostgreSQL, JSON text on SQLite. */
export function json<T>(name: string): ReturnType<typeof pgJson<T>> {
  return (isPg
    ? pgJson<T>(name)
    : sqlite.text(name, { mode: "json" }).$type<T>()) as unknown as ReturnType<
    typeof pgJson<T>
  >;
}

/** Bytes as the driver may hand them back: a Buffer, any Uint8Array, or hex text. */
export function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return Buffer.from(value.replace(/^\\x/, ""), "hex");
  }
  throw new TypeError("Unexpected value for a bytea column");
}

const pgBytes = (name: string) =>
  pg.customType<{ data: Buffer; driverData: Buffer | Uint8Array | string }>({
    dataType: () => "bytea",
    toDriver: (value) => value,
    fromDriver: toBuffer,
  })(name);

/** Binary data: `bytea` on PostgreSQL, a blob on SQLite. */
export const bytes = (name: string): ReturnType<typeof pgBytes> =>
  (isPg
    ? pgBytes(name)
    : sqlite.blob(name, { mode: "buffer" })) as unknown as ReturnType<
    typeof pgBytes
  >;

/**
 * `created_at` / `updated_at`, filled by the database on insert and by drizzle
 * on update. A column never has both `.default()` and `$defaultFn`: the two
 * dialects disagree on which wins.
 */
export function timestamps() {
  const now = isPg ? sql`clock_timestamp()` : sql`(unixepoch('subsec') * 1000)`;
  return {
    createdAt: instant("created_at").notNull().default(now),
    updatedAt: instant("updated_at")
      .notNull()
      .default(now)
      .$onUpdate(() => new Date()),
  };
}
