import { and, eq, inArray, lte, max } from "drizzle-orm";
import {
  accounts,
  fxRates,
  getDB,
  securities,
  securityPrices,
  trades,
} from "$lib/server/db";
import {
  heldQuantity,
  type HoldingFxRate,
  type HoldingPrice,
  type HoldingSecurity,
  type HoldingTrade,
  type HoldingsInput,
} from "./valuation";

/**
 * Holdings inputs of several accounts with four queries in total (trades with
 * their security and account currency, prices, FX rates). Accounts without
 * trades dated <= `to` are absent from the result.
 */
export async function loadHoldingsInputs(
  userId: string,
  accountIds: readonly string[],
  to: string,
): Promise<Map<string, HoldingsInput>> {
  const result = new Map<string, HoldingsInput>();
  if (accountIds.length === 0) return result;
  const db = getDB();

  const tradeRows = await db
    .select({
      accountId: trades.accountId,
      accountCurrency: accounts.currency,
      securityId: trades.securityId,
      securityName: securities.name,
      securityCurrency: securities.currency,
      date: trades.date,
      side: trades.side,
      quantity: trades.quantity,
      splitNew: trades.splitNew,
      splitOld: trades.splitOld,
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
    );
  if (tradeRows.length === 0) return result;

  const securityIds = [...new Set(tradeRows.map((t) => t.securityId))];
  const currencies = new Set<string>();
  for (const t of tradeRows) {
    currencies.add(t.accountCurrency);
    currencies.add(t.securityCurrency);
  }

  const pricesBySecurity = new Map<string, HoldingPrice[]>();
  for (const p of await db
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
    )) {
    const list = pricesBySecurity.get(p.securityId) ?? [];
    list.push(p);
    pricesBySecurity.set(p.securityId, list);
  }

  const fxRows: HoldingFxRate[] = await db
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
    );

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
        splitNew: r.splitNew,
        splitOld: r.splitOld,
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
 * Per account with trades: the newest date, up to `today`, of a trade or of a
 * manual price of a security the account still holds (quantity > 0 as of
 * `today`). Fetched prices arrive without the user looking at the account, so
 * they never count. Two queries.
 */
export async function latestHoldingsActivity(
  userId: string,
  accountIds: readonly string[],
  today: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const db = getDB();
  const note = (accountId: string, date: string | null) => {
    if (date !== null && date > (out.get(accountId) ?? "")) {
      out.set(accountId, date);
    }
  };
  const rows = await db
    .select({
      accountId: trades.accountId,
      securityId: trades.securityId,
      date: trades.date,
      side: trades.side,
      quantity: trades.quantity,
      splitNew: trades.splitNew,
      splitOld: trades.splitOld,
    })
    .from(trades)
    .where(
      and(
        eq(trades.userId, userId),
        inArray(trades.accountId, [...accountIds]),
        lte(trades.date, today),
      ),
    );
  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.accountId}\u0000${r.securityId}`;
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }
  const positions = [...grouped.values()].map((list) => ({
    accountId: list[0]!.accountId,
    securityId: list[0]!.securityId,
    last: list.reduce((m, r) => (r.date > m ? r.date : m), ""),
    held: heldQuantity(list),
  }));
  for (const p of positions) note(p.accountId, p.last);

  const heldIds = [
    ...new Set(positions.filter((p) => p.held > 0).map((p) => p.securityId)),
  ];
  if (heldIds.length === 0) return out;
  const lastManual = new Map(
    (
      await db
        .select({
          securityId: securityPrices.securityId,
          d: max(securityPrices.date),
        })
        .from(securityPrices)
        .where(
          and(
            eq(securityPrices.userId, userId),
            eq(securityPrices.source, "manual"),
            inArray(securityPrices.securityId, heldIds),
            lte(securityPrices.date, today),
          ),
        )
        .groupBy(securityPrices.securityId)
    ).map((r) => [r.securityId, r.d]),
  );
  for (const p of positions) {
    if (p.held > 0) note(p.accountId, lastManual.get(p.securityId) ?? null);
  }
  return out;
}
