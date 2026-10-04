import { sql, type SQL } from "drizzle-orm";

/**
 * Matching form of a payment reference: upper-case, without space, tab, LF and
 * CR. The SQL and the JS version must strip the same characters, so detection
 * (contributions) and exclusion (month summary, review) never disagree.
 */
export function matchReference(input: string): string {
  return input.replace(/[ \t\n\r]/g, "").toUpperCase();
}

/** SQL counterpart of `matchReference` for a reference column. */
export function matchReferenceSql(column: SQL | { getSQL(): SQL }): SQL {
  return sql`replace(replace(replace(replace(upper(${column}), ' ', ''), char(9), ''), char(10), ''), char(13), '')`;
}
