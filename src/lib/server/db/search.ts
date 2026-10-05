import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Escapes `\`, `%` and `_` so `value` matches literally inside a LIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `column` contains `term`, ignoring case, with `%` and `_` in the term taken
 * literally. A plain LIKE is case-insensitive on SQLite but case-sensitive on
 * PostgreSQL; lowering both sides makes both case-insensitive, and the explicit
 * escape character avoids depending on either engine's default. The folding
 * differs for non-ASCII text: case-insensitive for ASCII on SQLite, Unicode on
 * PostgreSQL.
 */
export function likeContains(column: SQLWrapper, term: string): SQL {
  const pattern = `%${escapeLike(term)}%`;
  return sql`lower(${column}) like lower(${pattern}) escape '\\'`;
}
