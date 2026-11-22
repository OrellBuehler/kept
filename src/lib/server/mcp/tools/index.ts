import { and, asc, eq, inArray } from "drizzle-orm";
import { accounts, categories, first, getDB, users } from "$lib/server/db";
import { notFound } from "$lib/server/ledger/errors";
import { getPreferences } from "$lib/server/preferences";
import { defineTool, toolAvailable, type AnyTool } from "../tool";
import { accountTools } from "./accounts";
import { billTools } from "./bills";
import { categoryTools } from "./categories";
import { changeTools } from "./changes";
import { matchTools } from "./matches";
import { overviewTools } from "./overview";
import { transactionTools } from "./transactions";

const whoami = defineTool({
  name: "whoami",
  title: "What this connection may do",
  description:
    "Describes this connection: the owner's name, locale and default currency, today's date, the permissions (scopes) it holds, any restriction to certain accounts or categories (with their ids and names), and the names of the tools it may use. Call this first. A restriction means every list, total and change only covers those accounts or categories; anything else answers not found.",
  scopes: [],
  annotations: { readOnlyHint: true },
  input: {},
  run: async (ctx) => {
    const user = await first(
      getDB()
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1),
    );
    if (!user) throw notFound("User");
    const prefs = await getPreferences(ctx.userId);
    const { accountIds, categoryIds } = ctx.grant;
    const [accountRows, categoryRows] = await Promise.all([
      accountIds === null || accountIds.length === 0
        ? []
        : getDB()
            .select({ id: accounts.id, name: accounts.name })
            .from(accounts)
            .where(
              and(
                eq(accounts.userId, ctx.userId),
                inArray(accounts.id, [...accountIds]),
              ),
            )
            .orderBy(asc(accounts.name), asc(accounts.id)),
      categoryIds === null || categoryIds.length === 0
        ? []
        : getDB()
            .select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(
              and(
                eq(categories.userId, ctx.userId),
                inArray(categories.id, [...categoryIds]),
              ),
            )
            .orderBy(asc(categories.name), asc(categories.id)),
    ]);
    return {
      user: {
        displayName: user.displayName,
        locale: prefs.locale,
        defaultCurrency: prefs.defaultCurrency,
      },
      today: ctx.today,
      connection: {
        name: ctx.grant.name,
        credential: ctx.grant.credential.kind,
        scopes: ctx.grant.scopes,
      },
      restrictions: {
        accounts: accountIds === null ? null : accountRows,
        categories: categoryIds === null ? null : categoryRows,
      },
      tools: TOOLS.filter((t) => toolAvailable(t, ctx.grant)).map(
        (t) => t.name,
      ),
    };
  },
});

/** Every tool the server knows; a grant sees the ones its scopes and restrictions allow. */
export const TOOLS: readonly AnyTool[] = [
  whoami,
  ...billTools,
  ...matchTools,
  ...transactionTools,
  ...accountTools,
  ...categoryTools,
  ...overviewTools,
  ...changeTools,
] as unknown as readonly AnyTool[];
