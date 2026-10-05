/**
 * Which database dialect this process uses. No `bun:*` imports: drizzle-kit
 * loads the schema (and so this file) under Node.
 */
export type Dialect = "sqlite" | "pg";

/**
 * Set by `drizzle.sqlite.config.ts` / `drizzle.pg.config.ts` to the dialect
 * drizzle-kit is generating for. The configs run before the schema is loaded,
 * in the same process, and must not import the schema.
 */
export const DRIZZLE_KIT_PIN_ENV = "KEPT_DRIZZLE_KIT_DIALECT";

type Env = Record<string, string | undefined>;

/** A `postgres://` or `postgresql://` DATABASE_URL means PostgreSQL; anything else SQLite. */
export function resolveDialect(env: Env = process.env): Dialect {
  const url = env.DATABASE_URL?.trim();
  return url && /^postgres(?:ql)?:\/\//i.test(url) ? "pg" : "sqlite";
}

/** The dialect drizzle-kit was pinned to, or null when it is not running. */
export function drizzleKitPin(env: Env = process.env): Dialect | null {
  const pin = env[DRIZZLE_KIT_PIN_ENV];
  if (pin === undefined || pin === "") return null;
  if (pin === "sqlite" || pin === "pg") return pin;
  throw new Error(
    `${DRIZZLE_KIT_PIN_ENV} must be "sqlite" or "pg", got "${pin}"`,
  );
}

/**
 * Throws when drizzle-kit was pinned to one dialect but the schema resolved to
 * the other. Without this a wrong environment silently generates a schema with
 * zero tables, or migrations that drop everything.
 */
export function assertPinMatches(
  resolved: Dialect,
  env: Env = process.env,
): void {
  const pin = drizzleKitPin(env);
  if (pin !== null && pin !== resolved) {
    throw new Error(
      `drizzle-kit is generating for "${pin}" but the schema resolved to "${resolved}"; DATABASE_URL must not be changed after the drizzle config ran`,
    );
  }
}

/** The dialect of this process, fixed when the module is first loaded. */
export const dialect: Dialect = resolveDialect();
