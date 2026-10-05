/**
 * Type predicates shared by the drizzle rules. A value is a drizzle query when
 * its type has `getSQL` or `toSQL`, which every query builder implements. The
 * object that `db.insert(table)` returns has neither, so its own `.values(row)`
 * is not mistaken for a query.
 */
const QUERY_MARKERS = ["getSQL", "toSQL"];
const DB_MEMBERS = ["select", "insert", "update", "delete"];

/**
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Type} type
 * @param {string[]} members properties of which at least one must exist
 * @returns {boolean}
 */
function hasAny(checker, type, members) {
  if (type.isUnion())
    return type.types.some((t) => hasAny(checker, t, members));
  const apparent = checker.getApparentType(type);
  return members.some((m) => checker.getPropertyOfType(apparent, m));
}

/**
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Type} type
 * @param {string[]} members properties that must all exist
 */
function hasAll(checker, type, members) {
  if (type.isUnion())
    return type.types.some((t) => hasAll(checker, t, members));
  const apparent = checker.getApparentType(type);
  return members.every((m) => checker.getPropertyOfType(apparent, m));
}

export const isQueryType = (checker, type) =>
  hasAny(checker, type, QUERY_MARKERS);

/** `db`, a transaction, or anything else that starts queries. */
export const isDatabaseType = (checker, type) =>
  hasAll(checker, type, DB_MEMBERS);

export { hasAll, hasAny };
