import { and, eq, inArray, lte, max } from "drizzle-orm";
import { getDB, portfolios, portfolioValues } from "$lib/server/db";
import type { PortfoliosInput } from "./valuation";

/**
 * Portfolio values of several accounts with one query. Accounts without
 * values dated <= `to` are absent from the result.
 */
export async function loadPortfolioInputs(
  userId: string,
  accountIds: readonly string[],
  to: string,
): Promise<Map<string, PortfoliosInput>> {
  const result = new Map<string, PortfoliosInput>();
  if (accountIds.length === 0) return result;
  const rows = await getDB()
    .select({
      accountId: portfolios.accountId,
      portfolioId: portfolios.id,
      closedOn: portfolios.closedOn,
      date: portfolioValues.date,
      amount: portfolioValues.amount,
    })
    .from(portfolioValues)
    .innerJoin(portfolios, eq(portfolios.id, portfolioValues.portfolioId))
    .where(
      and(
        eq(portfolioValues.userId, userId),
        eq(portfolios.userId, userId),
        inArray(portfolios.accountId, [...accountIds]),
        lte(portfolioValues.date, to),
      ),
    );
  const byAccount = new Map<
    string,
    Map<
      string,
      { closedOn: string | null; values: { date: string; amount: number }[] }
    >
  >();
  for (const r of rows) {
    let perPortfolio = byAccount.get(r.accountId);
    if (!perPortfolio) {
      perPortfolio = new Map();
      byAccount.set(r.accountId, perPortfolio);
    }
    let p = perPortfolio.get(r.portfolioId);
    if (!p) {
      p = { closedOn: r.closedOn, values: [] };
      perPortfolio.set(r.portfolioId, p);
    }
    p.values.push({ date: r.date, amount: r.amount });
  }
  for (const [accountId, perPortfolio] of byAccount) {
    result.set(accountId, [...perPortfolio.values()]);
  }
  return result;
}

/** Per account with portfolio values: the newest value date up to `today`. One query. */
export async function latestPortfolioValueDates(
  userId: string,
  accountIds: readonly string[],
  today: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  for (const r of await getDB()
    .select({ accountId: portfolios.accountId, d: max(portfolioValues.date) })
    .from(portfolioValues)
    .innerJoin(portfolios, eq(portfolios.id, portfolioValues.portfolioId))
    .where(
      and(
        eq(portfolioValues.userId, userId),
        eq(portfolios.userId, userId),
        inArray(portfolios.accountId, [...accountIds]),
        lte(portfolioValues.date, today),
      ),
    )
    .groupBy(portfolios.accountId)) {
    if (r.d !== null) out.set(r.accountId, r.d);
  }
  return out;
}
