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
 * - raw SQL (`sql\`...\``, `sql.raw("...")`) with `ilike`, `distinct on`,
 *   `for update` / `for share`, or `::` casts; with functions only SQLite has
 *   (`strftime`, `ifnull`, `group_concat`, `datetime(`, `unixepoch`, `rowid`,
 *   `glob`, `char(`, `insert or replace`, a two-argument scalar `min`/`max`);
 *   and with a plain `like`, which is case-insensitive on SQLite and
 *   case-sensitive on PostgreSQL: write `lower(col) like lower(?)` (see
 *   `likeContains` in `db/`), likewise for the `like()` / `notLike()` helpers;
 * - value imports from `drizzle-orm/pg-core`, `drizzle-orm/sqlite-core` and
 *   the driver packages, which only `db/` may use (type imports are fine).
 *
 * Both `import { ilike } from "drizzle-orm"` and `d.ilike` on a namespace
 * import are caught.
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

/** Exist on both databases but answer differently, so neither may be used. */
const DIFFERENT_IMPORTS = new Set(["like", "notLike"]);

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
  [/\bstrftime\b/i, "strftime() is SQLite-only; compute dates in TypeScript"],
  [/\bifnull\b/i, "ifnull() is SQLite-only; use coalesce()"],
  [
    /\bgroup_concat\b/i,
    "group_concat() is SQLite-only; aggregate in TypeScript",
  ],
  [
    /\bdatetime\s*\(/i,
    "datetime() is SQLite-only; compute dates in TypeScript",
  ],
  [/\bunixepoch\b/i, "unixepoch() is SQLite-only"],
  [/\browid\b/i, "rowid is SQLite-only; order by the seq column"],
  [/\bglob\b/i, "GLOB is SQLite-only"],
  [
    /\bchar\s*\(/i,
    "char() is SQLite-only (chr() on PostgreSQL); use a literal",
  ],
  [
    /\binsert\s+or\s+(?:replace|ignore)\b/i,
    "INSERT OR REPLACE/IGNORE is SQLite-only; use onConflictDoUpdate / onConflictDoNothing",
  ],
  [
    /\b(?:min|max)\s*\([^()]*,/i,
    "a scalar min(a, b) / max(a, b) is SQLite-only; compare in TypeScript or use a case expression",
  ],
];

/** `lower(x) like lower(y)`: the one spelling of LIKE that both databases answer alike. */
const LOWERED_LIKE = /lower\([^)]*\)\s+like\s+lower\(/i;
const PLAIN_LIKE = /\blike\b/i;

function rawSqlProblem(text) {
  for (const [pattern, reason] of RAW_SQL) {
    if (pattern.test(text)) return reason;
  }
  if (PLAIN_LIKE.test(text) && !LOWERED_LIKE.test(text)) {
    return "a plain LIKE is case-insensitive on SQLite and case-sensitive on PostgreSQL; use lower(col) like lower(?)";
  }
  return null;
}

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
      importDifferent:
        "`{{name}}` is case-insensitive on SQLite and case-sensitive on PostgreSQL; use lower(col) like lower(?) (likeContains in $lib/server/db).",
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

    /** Local names that `import * as x from "drizzle-orm..."` bound. */
    const drizzleNamespaces = new Set();
    /** Local names of drizzle's `sql` tag. */
    const sqlNames = new Set(["sql"]);
    const reportImportedName = (node, name) => {
      if (BANNED_IMPORTS.has(name)) {
        context.report({ node, messageId: "importName", data: { name } });
      } else if (DIFFERENT_IMPORTS.has(name)) {
        context.report({ node, messageId: "importDifferent", data: { name } });
      }
    };
    const isSqlTag = (tag) =>
      (tag.type === "Identifier" && sqlNames.has(tag.name)) ||
      (tag.type === "MemberExpression" &&
        !tag.computed &&
        tag.property.type === "Identifier" &&
        tag.property.name === "sql");
    const checkRaw = (node, text) => {
      if (dialectCode) return;
      const reason = rawSqlProblem(text);
      if (reason) context.report({ node, messageId: "raw", data: { reason } });
    };

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (isDrizzle(source)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportNamespaceSpecifier") {
              drizzleNamespaces.add(specifier.local.name);
              continue;
            }
            if (specifier.type !== "ImportSpecifier") continue;
            const name = specifier.imported.name ?? specifier.imported.value;
            if (name === "sql") sqlNames.add(specifier.local.name);
            reportImportedName(specifier, name);
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

      MemberExpression(node) {
        // `d.ilike(...)` after `import * as d from "drizzle-orm"`.
        if (
          node.computed ||
          node.object.type !== "Identifier" ||
          node.property.type !== "Identifier" ||
          !drizzleNamespaces.has(node.object.name)
        ) {
          return;
        }
        reportImportedName(node.property, node.property.name);
      },

      TaggedTemplateExpression(node) {
        if (dialectCode || !isSqlTag(node.tag)) return;
        const text = node.quasi.quasis
          .map((q) => q.value.cooked ?? q.value.raw)
          .join(" ");
        checkRaw(node, text);
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

        // sql.raw("...") with a literal string; a dynamic one cannot be read.
        if (name === "raw" && isSqlTag(callee.object)) {
          const arg = node.arguments[0];
          if (arg?.type === "Literal" && typeof arg.value === "string") {
            checkRaw(node, arg.value);
          } else if (arg?.type === "TemplateLiteral") {
            checkRaw(
              node,
              arg.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" "),
            );
          }
          return;
        }

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
