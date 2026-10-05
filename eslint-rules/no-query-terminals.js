/**
 * Bans the sync-style terminals on drizzle query builders:
 * `.all()`, `.get()`, `.run()`, `.values()` and `.execute()`. Builders are
 * awaited (or passed to first()): `.get()` skips first() and its limit,
 * `.run()` hides the result shape, and none of them exists on every database
 * backend.
 *
 * Decided by the receiver's type, not by the method name, so `Map.get(key)`,
 * `URLSearchParams.get(name)`, `Map.values()` and a raw `bun:sqlite`
 * statement are left alone. A receiver is a drizzle query when its type has
 * `getSQL` or `toSQL`, which every drizzle builder implements. The object that
 * `db.insert(table)` returns has neither, so its own `.values(row)` is fine.
 * A receiver typed `any` cannot be told apart and is skipped.
 */
import { isQueryType } from "./query-types.js";

const TERMINALS = new Set(["all", "get", "run", "values", "execute"]);

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      terminal:
        "Await the query (or use first()) instead of .{{name}}() on a query builder.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.getTypeAtLocation) {
      throw new Error(
        "kept/no-query-terminals needs type information: run it on files covered by the TypeScript project",
      );
    }
    const checker = services.program.getTypeChecker();
    const isQuery = (type) => isQueryType(checker, type);

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier") return;
        const name = callee.property.name;
        if (!TERMINALS.has(name)) return;
        if (!isQuery(services.getTypeAtLocation(callee.object))) return;
        context.report({
          node: callee.property,
          messageId: "terminal",
          data: { name },
        });
      },
    };
  },
};
