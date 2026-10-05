/**
 * Kept's schema and queries are written once, typed as drizzle's pg-core, and
 * run on SQLite as well as PostgreSQL. The pg-core types still describe things
 * SQLite cannot do; this rule bans them so they fail in lint rather than at
 * runtime on one of the two databases:
 *
 * - imports of `ilike`, `notIlike`, `arrayContains`, `arrayContained`,
 *   `arrayOverlaps`, `exceptAll` and `intersectAll` from drizzle;
 * - `db.execute()`, `db.selectDistinctOn()`, `db.refreshMaterializedView()`;
 * - `.for()` locking clauses and `*JoinLateral()` on a query;
 * - column builders: `.defaultNow()`, `.array()`, `.generatedAlwaysAsIdentity()`,
 *   `.generatedByDefaultAsIdentity()`, and `.unique(name, { nulls })`;
 *   `.nullsNotDistinct()` on a unique constraint;
 * - index options that only exist on PostgreSQL: `.using()`, `.concurrently()`,
 *   `.with()`, `.onOnly()` on an index, and `.asc()`, `.desc()`,
 *   `.nullsFirst()`, `.nullsLast()`, `.op()` on an indexed column;
 * - raw SQL templates (`sql\`...\``) with `ilike`, `distinct on`, `for update`
 *   / `for share`, or `::` casts;
 * - value imports from `drizzle-orm/pg-core`, `drizzle-orm/sqlite-core` and
 *   the driver packages, which only `db/` may use (type imports are fine).
 *
 * Methods are matched by the receiver's type, not just their name, so
 * `Symbol.for()`, zod's `.array()` and a CTE `db.with(cte)` are left alone.
 * Receivers typed `any` cannot be told apart and are skipped, except for names
 * that exist nowhere else.
 *
 * The `dialectCode` option switches off the raw SQL and module-import checks
 * for the one directory (`src/lib/server/db/`) that is dialect code by nature;
 * `driverImports` switches off only the module-import check, for tests that
 * run the migrator or open a raw handle.
 */
import { isDatabaseType, isQueryType, hasAll } from "./query-types.js";

const BANNED_IMPORTS = new Set([
  "ilike",
  "notIlike",
  "arrayContains",
  "arrayContained",
  "arrayOverlaps",
  "exceptAll",
  "intersectAll",
]);

/** Names that exist only on pg-core builders, so the receiver's type is not needed. */
const UNAMBIGUOUS = new Map([
  [
    "defaultNow",
    "`.defaultNow()` is PostgreSQL-only; the schema default comes from timestamps()",
  ],
  [
    "selectDistinctOn",
    "`selectDistinctOn()` is PostgreSQL-only; use `selectDistinct()` or group by",
  ],
  ["refreshMaterializedView", "materialized views do not exist on SQLite"],
  ["leftJoinLateral", "lateral joins are PostgreSQL-only"],
  ["innerJoinLateral", "lateral joins are PostgreSQL-only"],
  ["crossJoinLateral", "lateral joins are PostgreSQL-only"],
  ["nullsNotDistinct", "`.nullsNotDistinct()` is PostgreSQL-only"],
  ["generatedAlwaysAsIdentity", "identity columns are PostgreSQL-only"],
  ["generatedByDefaultAsIdentity", "identity columns are PostgreSQL-only"],
]);

const INDEX_TYPES = new Set(["IndexBuilder", "IndexBuilderOn"]);
const INDEX_OPTIONS = new Set(["using", "concurrently", "with", "onOnly"]);
const INDEXED_COLUMN_OPTIONS = new Set([
  "asc",
  "desc",
  "nullsFirst",
  "nullsLast",
  "op",
]);

const RAW_SQL = [
  [/\bilike\b/i, "ILIKE is PostgreSQL-only; compare lower(col) like lower(?)"],
  [/\bdistinct\s+on\b/i, "DISTINCT ON is PostgreSQL-only"],
  [
    /\bfor\s+(?:no\s+key\s+)?(?:update|share)\b/i,
    "row locking clauses are PostgreSQL-only",
  ],
  [/::\s*[a-z_"]/i, "`::` casts are PostgreSQL-only; use cast(x as type)"],
];

const DRIVER_MODULES = new Set([
  "drizzle-orm/pg-core",
  "drizzle-orm/sqlite-core",
  "drizzle-orm/bun-sql",
  "drizzle-orm/bun-sqlite",
  "drizzle-orm/sqlite-proxy",
]);

const isDrizzle = (source) =>
  source === "drizzle-orm" || source.startsWith("drizzle-orm/");

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          dialectCode: { type: "boolean" },
          driverImports: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      importName:
        "`{{name}}` is PostgreSQL-only and has no SQLite equivalent; the code must run on both.",
      importModule:
        "Import values from `{{source}}` only inside src/lib/server/db/ (a type import is fine); use `$lib/server/db`.",
      call: "{{reason}}.",
      raw: "Raw SQL must run on SQLite and PostgreSQL: {{reason}}.",
      pgOnlyOption:
        "`.{{name}}()` is a PostgreSQL-only {{what}} option; it does not exist on SQLite.",
      unique:
        "`.unique(name, config)` takes PostgreSQL-only options (`nulls`); give the unique constraint a name only.",
    },
  },
  create(context) {
    const dialectCode = context.options[0]?.dialectCode === true;
    const driverImports =
      dialectCode || context.options[0]?.driverImports === true;
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.getTypeAtLocation) {
      throw new Error(
        "kept/no-pg-only-api needs type information: run it on files covered by the TypeScript project",
      );
    }
    const checker = services.program.getTypeChecker();
    const typeOf = (node) => services.getTypeAtLocation(node);
    const typeName = (type) => (type.aliasSymbol ?? type.symbol)?.name;
    const isAny = (type) => (type.flags & 1) !== 0;
    /** Is any constituent of `type` named one of `names`? */
    const namedAnyOf = (type, names) =>
      type.isUnion()
        ? type.types.some((t) => namedAnyOf(t, names))
        : names.has(typeName(type) ?? "");
    const isColumnBuilder = (type) =>
      hasAll(checker, type, ["notNull", "$type"]);

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (isDrizzle(source)) {
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier") continue;
            const name = specifier.imported.name ?? specifier.imported.value;
            if (BANNED_IMPORTS.has(name)) {
              context.report({
                node: specifier,
                messageId: "importName",
                data: { name },
              });
            }
          }
        }
        if (
          !driverImports &&
          DRIVER_MODULES.has(source) &&
          node.importKind !== "type" &&
          node.specifiers.some(
            (s) => s.type !== "ImportSpecifier" || s.importKind !== "type",
          )
        ) {
          context.report({ node, messageId: "importModule", data: { source } });
        }
      },

      TaggedTemplateExpression(node) {
        if (dialectCode) return;
        const tag = node.tag;
        const named =
          (tag.type === "Identifier" && tag.name === "sql") ||
          (tag.type === "MemberExpression" &&
            tag.property.type === "Identifier" &&
            tag.property.name === "sql");
        if (!named) return;
        const text = node.quasi.quasis
          .map((q) => q.value.cooked ?? q.value.raw)
          .join(" ");
        for (const [pattern, reason] of RAW_SQL) {
          if (pattern.test(text)) {
            context.report({ node, messageId: "raw", data: { reason } });
            return;
          }
        }
      },

      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier") return;
        const name = callee.property.name;
        const report = (messageId, data) =>
          context.report({ node: callee.property, messageId, data });

        const reason = UNAMBIGUOUS.get(name);
        if (reason) return report("call", { reason });

        if (name === "unique" && node.arguments.length >= 2)
          return report("unique");

        const receiver = typeOf(callee.object);
        if (isAny(receiver)) return;

        if (name === "execute" && isDatabaseType(checker, receiver)) {
          return report("call", {
            reason:
              "`db.execute()` is PostgreSQL-only; build the query with drizzle's builders",
          });
        }
        if (name === "for" && isQueryType(checker, receiver)) {
          return report("call", {
            reason:
              "`.for()` locking clauses are PostgreSQL-only; use transaction({ lock })",
          });
        }
        if (name === "array" && isColumnBuilder(receiver)) {
          return report("call", {
            reason: "array columns are PostgreSQL-only",
          });
        }
        if (INDEX_OPTIONS.has(name) && namedAnyOf(receiver, INDEX_TYPES)) {
          return report("pgOnlyOption", { name, what: "index" });
        }
        if (
          INDEXED_COLUMN_OPTIONS.has(name) &&
          namedAnyOf(receiver, new Set(["ExtraConfigColumn"]))
        ) {
          return report("pgOnlyOption", { name, what: "index column" });
        }
      },
    };
  },
};
