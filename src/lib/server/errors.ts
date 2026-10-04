/**
 * Log-safe error descriptions. Database errors (drizzle) carry the SQL text and
 * its bound parameters in `message` and `params`, which hold descriptions,
 * amounts, IBANs and password hashes. Only the class names and the error code
 * are ever read from an error; its message is never included.
 */
const MAX_DEPTH = 5;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface SafeErrorInfo {
  /** class names from the outermost error down the `cause` chain */
  names: string[];
  /** first machine-readable code found in the chain, e.g. SQLITE_CONSTRAINT_UNIQUE */
  code: string | null;
}

export function safeErrorInfo(err: unknown): SafeErrorInfo {
  const names: string[] = [];
  let code: string | null = null;
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
    current = (current as { cause?: unknown }).cause;
  }
  if (names.length === 0) names.push("unknown");
  return { names, code };
}

/** e.g. `DrizzleQueryError > SQLiteError [SQLITE_CONSTRAINT_UNIQUE]` */
export function describeError(err: unknown): string {
  const { names, code } = safeErrorInfo(err);
  const chain = names.join(" > ");
  return code === null ? chain : `${chain} [${code}]`;
}

/** Just the code, or the outermost class name when the chain has none. */
export function errorCode(err: unknown): string {
  const { names, code } = safeErrorInfo(err);
  return code ?? names[0];
}
