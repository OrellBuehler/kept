/**
 * Log-safe error descriptions. Database errors (drizzle) carry the SQL text and
 * its bound parameters in `message` and `params`, which hold descriptions,
 * amounts, IBANs and password hashes. Only the class names and the error code
 * are ever read from an error; its message is never included.
 */
const MAX_DEPTH = 5;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A PostgreSQL SQLSTATE: five digits or capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A schema identifier such as a constraint name, never row data. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface SafeErrorInfo {
  /** class names from the outermost error down the `cause` chain */
  names: string[];
  /** first machine-readable code found in the chain, e.g. SQLITE_CONSTRAINT_UNIQUE */
  code: string | null;
  /**
   * PostgreSQL SQLSTATE. Bun's driver keeps it in `errno` (a string) and puts
   * its own generic code in `code`; SQLite's `errno` is a number and ignored.
   */
  sqlState: string | null;
  /** Name of the violated constraint, which is schema, not data. */
  constraint: string | null;
}

export function safeErrorInfo(err: unknown): SafeErrorInfo {
  const names: string[] = [];
  let code: string | null = null;
  let sqlState: string | null = null;
  let constraint: string | null = null;
  let current: unknown = err;
  for (let depth = 0; depth < MAX_DEPTH && current != null; depth++) {
    if (typeof current !== "object") {
      names.push(typeof current);
      break;
    }
    const name = (current as { name?: unknown }).name;
    names.push(
      typeof name === "string" && SAFE_NAME.test(name) ? name : "Error",
    );
    if (code === null) {
      const c = (current as { code?: unknown }).code;
      if (typeof c === "string" && SAFE_CODE.test(c)) code = c;
    }
    if (sqlState === null) {
      const e = (current as { errno?: unknown }).errno;
      if (typeof e === "string" && SQLSTATE.test(e)) sqlState = e;
    }
    if (constraint === null && sqlState !== null) {
      const c = (current as { constraint?: unknown }).constraint;
      if (typeof c === "string" && SAFE_IDENTIFIER.test(c)) constraint = c;
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (names.length === 0) names.push("unknown");
  return { names, code, sqlState, constraint };
}

/**
 * e.g. `DrizzleQueryError > SQLiteError [SQLITE_CONSTRAINT_UNIQUE]`, or for
 * PostgreSQL `... > PostgresError [ERR_POSTGRES_SERVER_ERROR sqlstate=23505
 * constraint=users_username_key]`. Never the message, query, params or detail.
 */
export function describeError(err: unknown): string {
  const { names, code, sqlState, constraint } = safeErrorInfo(err);
  const chain = names.join(" > ");
  const parts = [
    code,
    sqlState && `sqlstate=${sqlState}`,
    constraint && `constraint=${constraint}`,
  ].filter((p): p is string => !!p);
  return parts.length === 0 ? chain : `${chain} [${parts.join(" ")}]`;
}

/**
 * Just the code (the SQLSTATE for PostgreSQL), or the outermost class name
 * when the chain has none.
 */
export function errorCode(err: unknown): string {
  const { names, code, sqlState } = safeErrorInfo(err);
  return sqlState ?? code ?? names[0];
}
