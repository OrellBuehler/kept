import { and, eq, inArray, type SQL } from "drizzle-orm";
import { accounts, first, getDB, transactions } from "$lib/server/db";
import { notFound } from "./errors";

/**
 * What a restricted credential (an API token, an MCP connection) may see. Null
 * means "everything of the user"; a list is the only set that exists as far as
 * the credential is concerned. An empty list sees nothing (token creation
 * refuses it, but a deleted account or category can leave one behind).
 */
export interface Visibility {
  readonly categoryIds: readonly string[] | null;
  readonly accountIds: readonly string[] | null;
}

export const UNRESTRICTED: Visibility = { categoryIds: null, accountIds: null };

export const isRestricted = (v: Visibility): boolean =>
  v.categoryIds !== null || v.accountIds !== null;

/** `column IN (ids)`; an empty list matches nothing. */
function within(
  column: Parameters<typeof inArray>[0],
  ids: readonly string[],
): SQL {
  return ids.length === 0 ? eq(transactions.id, "") : inArray(column, [...ids]);
}

/**
 * The condition that keeps a query on `transactions` inside the visibility,
 * or undefined when nothing is restricted. Every transaction read of a
 * restricted credential goes through this: a payment without a category is
 * invisible to a category restriction, a payment of another account to an
 * account restriction.
 */
export function transactionVisibility(
  v: Visibility | undefined,
): SQL | undefined {
  if (!v) return undefined;
  return and(
    v.accountIds !== null
      ? within(transactions.accountId, v.accountIds)
      : undefined,
    v.categoryIds !== null
      ? within(transactions.categoryId, v.categoryIds)
      : undefined,
  );
}

/** The condition that keeps a query on `accounts` inside the visibility. */
export function accountVisibility(v: Visibility | undefined): SQL | undefined {
  if (!v || v.accountIds === null) return undefined;
  return v.accountIds.length === 0
    ? eq(accounts.id, "")
    : inArray(accounts.id, [...v.accountIds]);
}

export const accountAllowed = (v: Visibility, accountId: string): boolean =>
  v.accountIds === null || v.accountIds.includes(accountId);

export const categoryAllowed = (
  v: Visibility,
  categoryId: string | null,
): boolean =>
  v.categoryIds === null ||
  (categoryId !== null && v.categoryIds.includes(categoryId));

/** The ids among `ids` that are the user's own transactions inside the visibility. */
export async function visibleTransactionIds(
  userId: string,
  v: Visibility | undefined,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await getDB()
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, unique.slice(i, i + 500)),
          transactionVisibility(v),
        ),
      );
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** Throws "Transaction not found" for a payment of another user or outside the visibility. */
export async function assertTransactionVisible(
  userId: string,
  v: Visibility | undefined,
  id: string,
): Promise<void> {
  const found = await first(
    getDB()
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, id),
          transactionVisibility(v),
        ),
      )
      .limit(1),
  );
  if (!found) throw notFound("Transaction");
}
