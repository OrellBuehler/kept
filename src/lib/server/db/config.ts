import { z } from "zod";
import { resolveDialect } from "./dialect";

export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_PG_TRANSACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_APPLICATION_NAME = "kept";

export interface SqliteDatabaseConfig {
  kind: "sqlite";
  path: string;
}

export interface PostgresDatabaseConfig {
  kind: "postgres";
  /** Contains the password: never log it or put it in an error message. */
  url: string;
  /** Connections in the pool. */
  poolMax: number;
  /** Longest a single statement may run; 0 disables the limit. */
  statementTimeoutMs: number;
  /** Longest a transaction may stay open (PostgreSQL 17+); 0 disables the limit. */
  transactionTimeoutMs: number;
  applicationName: string;
  /** False for connection poolers in transaction mode (PgBouncer). */
  prepare: boolean;
}

export type DatabaseConfig = SqliteDatabaseConfig | PostgresDatabaseConfig;

const timeoutMs = (fallback: number) =>
  z.coerce
    .number()
    .int("must be a whole number of milliseconds")
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .default(fallback);

const postgresSchema = z.object({
  DATABASE_URL: z
    .string()
    .refine(
      (v) => URL.canParse(v),
      "must be a valid postgres:// or postgresql:// URL",
    ),
  KEPT_DB_POOL_MAX: z.coerce
    .number()
    .int("must be a whole number")
    .min(1)
    .max(500)
    .default(DEFAULT_POOL_MAX),
  KEPT_DB_STATEMENT_TIMEOUT_MS: timeoutMs(DEFAULT_STATEMENT_TIMEOUT_MS),
  KEPT_DB_TRANSACTION_TIMEOUT_MS: timeoutMs(DEFAULT_PG_TRANSACTION_TIMEOUT_MS),
  KEPT_DB_APPLICATION_NAME: z
    .string()
    .regex(
      /^[A-Za-z0-9_.:@/-]{1,63}$/,
      "must be 1-63 characters of A-Za-z0-9_.:@/-",
    )
    .default(DEFAULT_APPLICATION_NAME),
  KEPT_DB_PREPARE: z.enum(["true", "false"]).default("true"),
});

function invalid(problems: string): Error {
  return new Error(`Invalid database configuration (${problems})`);
}

/**
 * `DATABASE_URL` with a `postgres://` or `postgresql://` scheme selects
 * PostgreSQL; with it unset, SQLite is used at `DATABASE_PATH` (default
 * `./data/kept.db`). A `DATABASE_URL` with any other value is an error rather
 * than a silent fall back to an empty SQLite file. The `KEPT_DB_*` tuning
 * variables only matter for PostgreSQL and are ignored otherwise. Invalid
 * values throw; messages name variables and never include their values, since
 * the URL carries the password.
 */
export function readDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const url = env.DATABASE_URL?.trim() || undefined;
  if (url === undefined || resolveDialect({ DATABASE_URL: url }) !== "pg") {
    if (url !== undefined) {
      throw invalid(
        "DATABASE_URL: must start with postgres:// or postgresql://; unset it to use SQLite at DATABASE_PATH",
      );
    }
    return {
      kind: "sqlite",
      path: env.DATABASE_PATH ?? "./data/kept.db",
    };
  }
  const raw: Record<string, string | undefined> = { DATABASE_URL: url };
  for (const key of [
    "KEPT_DB_POOL_MAX",
    "KEPT_DB_STATEMENT_TIMEOUT_MS",
    "KEPT_DB_TRANSACTION_TIMEOUT_MS",
    "KEPT_DB_APPLICATION_NAME",
    "KEPT_DB_PREPARE",
  ]) {
    raw[key] = env[key]?.trim() || undefined;
  }
  const parsed = postgresSchema.safeParse(raw);
  if (!parsed.success) {
    // Issue messages are schema text, never the received value.
    throw invalid(
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  const c = parsed.data;
  return {
    kind: "postgres",
    url: c.DATABASE_URL,
    poolMax: c.KEPT_DB_POOL_MAX,
    statementTimeoutMs: c.KEPT_DB_STATEMENT_TIMEOUT_MS,
    transactionTimeoutMs: c.KEPT_DB_TRANSACTION_TIMEOUT_MS,
    applicationName: c.KEPT_DB_APPLICATION_NAME,
    prepare: c.KEPT_DB_PREPARE === "true",
  };
}
