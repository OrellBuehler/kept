import { sql, type SQL } from "drizzle-orm";
import { normalizeReference } from "$lib/references";

/**
 * Every character `\s` matches in JavaScript. The SQL version replaces exactly
 * these, so detection (contributions) and exclusion (month summary, review)
 * never disagree, and both agree with `normalizeReference`, which also
 * normalizes the stored deposit references.
 */
const WHITESPACE = [
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
  "﻿",
];

/** Matching form of a payment reference: upper-case, without whitespace. */
export function matchReference(input: string): string {
  return normalizeReference(input);
}

/** SQL counterpart of `matchReference` for a reference column. */
export function matchReferenceSql(column: SQL | { getSQL(): SQL }): SQL {
  // Bound parameters: char() is SQLite-only and chr() PostgreSQL-only.
  return WHITESPACE.reduce<SQL>(
    (acc, ch) => sql`replace(${acc}, ${ch}, '')`,
    sql`upper(${column})`,
  );
}
