import { minor } from "$lib/money";
import { parseFixed } from "$lib/quantity";
import {
  createSecurity,
  createTrade,
  setManualPrice,
  upsertProviderPrices,
  type SecurityInput,
  type TradeInput,
} from "$lib/server/investments";

export function seedSecurity(
  userId: string,
  over: Partial<SecurityInput> = {},
) {
  return createSecurity(userId, {
    name: "Example World ETF",
    kind: "etf",
    isin: null,
    symbol: null,
    currency: "CHF",
    ...over,
  });
}

/** Quantity, price and amount are decimal strings, e.g. qty "10", price "100", amount "1005". */
export function seedTrade(
  userId: string,
  accountId: string,
  securityId: string,
  over: {
    date?: string;
    side?: TradeInput["side"];
    qty?: string;
    price?: string;
    fees?: number;
    amount: number;
    note?: string | null;
  },
) {
  return createTrade(userId, accountId, {
    securityId,
    date: over.date ?? "2024-01-15",
    side: over.side ?? "buy",
    quantity: parseFixed(over.qty ?? "10"),
    price: parseFixed(over.price ?? "100"),
    fees: minor(over.fees ?? 0),
    amount: minor(over.amount),
    note: over.note ?? null,
  });
}

export function seedManualPrice(
  userId: string,
  securityId: string,
  date: string,
  price: string,
) {
  return setManualPrice(userId, securityId, { date, price: parseFixed(price) });
}

export function seedProviderPrice(
  userId: string,
  securityId: string,
  date: string,
  price: string,
) {
  upsertProviderPrices(userId, securityId, [
    { date, price: parseFixed(price) },
  ]);
}
