import { and, eq, inArray, lte, max } from "drizzle-orm";
import {
  accounts,
  fxRates,
  getDB,
  securities,
  securityPrices,
  trades,
} from "$lib/server/db";
import type {
  HoldingFxRate,
  HoldingPrice,
  HoldingSecurity,
  HoldingTrade,
  HoldingsInput,
} from "./valuation";

/**
 * Holdings inputs of several accounts with four queries in total (trades with
 * their security and account currency, prices, FX rates). Accounts without
 * trades dated <= `to` are absent from the result.
 */
export function loadHoldingsInputs(
  userId: string,
  accountIds: readonly string[],
  to: string,
): Map<string, HoldingsInput> {
  const result = new Map<string, HoldingsInput>();
  if (accountIds.length === 0) return result;
  const db = getDB();

  const tradeRows = db
    .select({
      accountId: trades.accountId,
      accountCurrency: accounts.currency,
      securityId: trades.securityId,
      securityName: securities.name,
      securityCurrency: securities.currency,
      date: trades.date,
      side: trades.side,
      quantity: trades.quantity,
      price: trades.price,
      amount: trades.amount,
    })
    .from(trades)
    .innerJoin(accounts, eq(accounts.id, trades.accountId))
    .innerJoin(securities, eq(securities.id, trades.securityId))
    .where(
      and(
        eq(trades.userId, userId),
        inArray(trades.accountId, [...accountIds]),
        lte(trades.date, to),
      ),
    )
    .all();
  if (tradeRows.length === 0) return result;

  const securityIds = [...new Set(tradeRows.map((t) => t.securityId))];
  const currencies = new Set<string>();
  for (const t of tradeRows) {
    currencies.add(t.accountCurrency);
    currencies.add(t.securityCurrency);
  }

  const pricesBySecurity = new Map<string, HoldingPrice[]>();
  for (const p of db
    .select({
      securityId: securityPrices.securityId,
      date: securityPrices.date,
      price: securityPrices.price,
      source: securityPrices.source,
    })
    .from(securityPrices)
    .where(
      and(
        eq(securityPrices.userId, userId),
        inArray(securityPrices.securityId, securityIds),
        lte(securityPrices.date, to),
      ),
    )
    .all()) {
    const list = pricesBySecurity.get(p.securityId) ?? [];
    list.push(p);
    pricesBySecurity.set(p.securityId, list);
  }

  const fxRows: HoldingFxRate[] = db
    .select({
      base: fxRates.base,
      quote: fxRates.quote,
      date: fxRates.date,
      rate: fxRates.rate,
      source: fxRates.source,
    })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.userId, userId),
        inArray(fxRates.base, [...currencies]),
        inArray(fxRates.quote, [...currencies]),
        lte(fxRates.date, to),
      ),
    )
    .all();

  const byAccount = new Map<string, typeof tradeRows>();
  for (const t of tradeRows) {
    const list = byAccount.get(t.accountId) ?? [];
    list.push(t);
    byAccount.set(t.accountId, list);
  }
  for (const [accountId, rows] of byAccount) {
    const accountCurrency = rows[0]!.accountCurrency;
    const held = new Map<string, HoldingSecurity>();
    for (const r of rows) {
      held.set(r.securityId, {
        id: r.securityId,
        name: r.securityName,
        currency: r.securityCurrency,
      });
    }
    const relevant = new Set([
      accountCurrency,
      ...[...held.values()].map((s) => s.currency),
    ]);
    result.set(accountId, {
      accountCurrency,
      securities: [...held.values()],
      trades: rows.map((r): HoldingTrade => ({
        securityId: r.securityId,
        date: r.date,
        side: r.side,
        quantity: r.quantity,
        price: r.price,
        amount: r.amount,
      })),
      prices: [...held.keys()].flatMap((id) => pricesBySecurity.get(id) ?? []),
      fx: fxRows.filter((r) => relevant.has(r.base) && relevant.has(r.quote)),
    });
  }
  return result;
}

/**
 * Per account with trades: the newest date, up to `today`, of a trade or a
 * price of a security traded in that account. Two queries.
 */
export function latestHoldingsActivity(
  userId: string,
  accountIds: readonly string[],
  today: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const db = getDB();
  const ids = [...accountIds];
  const note = (accountId: string, date: string | null) => {
    if (date !== null && date > (out.get(accountId) ?? "")) {
      out.set(accountId, date);
    }
  };
  for (const r of db
    .select({ accountId: trades.accountId, d: max(trades.date) })
    .from(trades)
    .where(
      and(
        eq(trades.userId, userId),
        inArray(trades.accountId, ids),
        lte(trades.date, today),
      ),
    )
    .groupBy(trades.accountId)
    .all()) {
    note(r.accountId, r.d);
  }
  for (const r of db
    .select({ accountId: trades.accountId, d: max(securityPrices.date) })
    .from(securityPrices)
    .innerJoin(trades, eq(trades.securityId, securityPrices.securityId))
    .where(
      and(
        eq(trades.userId, userId),
        eq(securityPrices.userId, userId),
        inArray(trades.accountId, ids),
        lte(securityPrices.date, today),
      ),
    )
    .groupBy(trades.accountId)
    .all()) {
    note(r.accountId, r.d);
  }
  return out;
}
