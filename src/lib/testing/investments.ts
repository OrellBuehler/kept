import { minor } from "$lib/money";
import { fixed, parseFixed, scaleFixed } from "$lib/quantity";
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
    /** Split only: the exact integer ratio. */
    split?: { new: number; old: number };
  },
) {
  return createTrade(userId, accountId, {
    securityId,
    date: over.date ?? "2024-01-15",
    side: over.side ?? "buy",
    quantity: over.split
      ? scaleFixed(fixed(100_000_000), over.split.new, over.split.old)
      : parseFixed(over.qty ?? "10"),
    price: parseFixed(over.price ?? "100"),
    fees: minor(over.fees ?? 0),
    amount: minor(over.amount),
    note: over.note ?? null,
    splitNew: over.split?.new ?? null,
    splitOld: over.split?.old ?? null,
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
