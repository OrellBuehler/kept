import type { PriceSource, TradeSide } from "$lib/investment-types";
import { minor, type Minor } from "$lib/money";
import {
  fixed,
  invertFixed,
  proportionOf,
  valueOf,
  type Fixed8,
} from "$lib/quantity";

/**
 * Holdings model
 * --------------
 * - Pure: no database access. `load.ts` fills `HoldingsInput` from the database.
 * - Trades on the same date apply buys before sells. A trade dated D counts
 *   in the holdings of D (end-of-day, like transactions).
 * - Cost basis uses the average-cost method: a sell removes basis in
 *   proportion to the quantity sold. A buy adds its `amount` (cash paid
 *   including fees, in the account currency).
 * - Price on D: the latest price dated <= D (a manual price wins over a
 *   fetched one on the same date), or the latest trade price when a trade is
 *   newer than every price (or there is no price at all).
 * - FX from the security's currency to the account currency: 1 for the same
 *   currency, otherwise the latest rate dated <= D, direct or inverse pair.
 *   Without any rate the position is valued at its cost basis and flagged
 *   `estimated`.
 */

export interface HoldingSecurity {
  id: string;
  name: string;
  currency: string;
}

export interface HoldingTrade {
  securityId: string;
  date: string;
  side: TradeSide;
  quantity: Fixed8;
  /** Per unit, in the security's currency. */
  price: Fixed8;
  /** Account currency, positive. */
  amount: number;
}

export interface HoldingPrice {
  securityId: string;
  date: string;
  price: Fixed8;
  source?: string;
}

export interface HoldingFxRate {
  base: string;
  quote: string;
  date: string;
  rate: Fixed8;
  source?: string;
}

export interface HoldingsInput {
  accountCurrency: string;
  securities: readonly HoldingSecurity[];
  trades: readonly HoldingTrade[];
  prices: readonly HoldingPrice[];
  fx: readonly HoldingFxRate[];
}

export interface Position {
  securityId: string;
  name: string;
  /** Currency of `price`. */
  currency: string;
  quantity: Fixed8;
  price: Fixed8;
  priceDate: string;
  priceSource: PriceSource | "trade";
  /** Security currency to account currency; null when no rate is known. */
  fxRate: Fixed8 | null;
  /** Account currency. */
  value: Minor;
  /** Remaining cost basis, account currency. */
  cost: Minor;
  /** `value - cost`; zero for estimated positions. */
  gain: Minor;
  /** Valued at cost basis because an FX rate is missing. */
  estimated: boolean;
}

export interface HoldingsValue {
  value: Minor;
  cost: Minor;
  positions: Position[];
  estimated: boolean;
}

export type HoldingsValueAt = (date: string) => HoldingsValue;

const ONE = fixed(100_000_000);

const byDate = <T extends { date: string }>(a: T, b: T) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

function upperBound(
  sorted: readonly { date: string }[],
  target: string,
): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.date <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Latest entry with date <= target. */
function latestAt<T extends { date: string }>(
  sorted: readonly T[],
  target: string,
): T | undefined {
  return sorted[upperBound(sorted, target) - 1];
}

/** One value per date, sorted by date; a manual one beats another source. */
function dedupe<T extends { date: string; source?: string }>(
  rows: readonly T[],
): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const existing = best.get(row.date);
    if (
      !existing ||
      (row.source === "manual" && existing.source !== "manual")
    ) {
      best.set(row.date, row);
    }
  }
  return [...best.values()].sort(byDate);
}

function compareTrades(
  a: { date: string; side: TradeSide },
  b: { date: string; side: TradeSide },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.side === b.side) return 0;
  return a.side === "buy" ? -1 : 1;
}

interface Step {
  date: string;
  quantity: number;
  cost: number;
  tradePrice: Fixed8;
}

function timeline(trades: readonly HoldingTrade[]): Step[] {
  const sorted = [...trades].sort(compareTrades);
  const steps: Step[] = [];
  let quantity = 0;
  let cost = 0;
  for (const t of sorted) {
    if (t.side === "buy") {
      quantity += t.quantity;
      cost += t.amount;
    } else if (t.quantity >= quantity) {
      quantity = 0;
      cost = 0;
    } else {
      cost -= proportionOf(minor(cost), t.quantity, fixed(quantity));
      quantity -= t.quantity;
    }
    steps.push({ date: t.date, quantity, cost, tradePrice: t.price });
  }
  return steps;
}

/**
 * Builds a holdings lookup: O(n log n) once, O(securities * log n) per date.
 */
export function makeHoldingsValueAt(input: HoldingsInput): HoldingsValueAt {
  const securities = new Map(input.securities.map((s) => [s.id, s]));

  const tradesBySecurity = new Map<string, HoldingTrade[]>();
  for (const t of input.trades) {
    const list = tradesBySecurity.get(t.securityId) ?? [];
    list.push(t);
    tradesBySecurity.set(t.securityId, list);
  }
  const steps = new Map(
    [...tradesBySecurity].map(([id, list]) => [id, timeline(list)]),
  );

  const pricesBySecurity = new Map<string, HoldingPrice[]>();
  for (const p of input.prices) {
    const list = pricesBySecurity.get(p.securityId) ?? [];
    list.push(p);
    pricesBySecurity.set(p.securityId, list);
  }
  const prices = new Map(
    [...pricesBySecurity].map(([id, list]) => [id, dedupe(list)]),
  );

  const ratesByPair = new Map<string, HoldingFxRate[]>();
  for (const r of input.fx) {
    if (r.rate <= 0) continue;
    const key = `${r.base}/${r.quote}`;
    const list = ratesByPair.get(key) ?? [];
    list.push(r);
    ratesByPair.set(key, list);
  }
  const rates = new Map(
    [...ratesByPair].map(([key, list]) => [key, dedupe(list)]),
  );

  const fxAt = (currency: string, date: string) => {
    if (currency === input.accountCurrency) {
      return { rate: ONE, inverse: false };
    }
    const direct = latestAt(
      rates.get(`${currency}/${input.accountCurrency}`) ?? [],
      date,
    );
    const inverse = latestAt(
      rates.get(`${input.accountCurrency}/${currency}`) ?? [],
      date,
    );
    if (direct && (!inverse || direct.date >= inverse.date)) {
      return { rate: direct.rate, inverse: false };
    }
    if (inverse) return { rate: inverse.rate, inverse: true };
    return null;
  };

  const ids = [...steps.keys()];

  return (date) => {
    const positions: Position[] = [];
    for (const id of ids) {
      const security = securities.get(id);
      const step = latestAt(steps.get(id)!, date);
      if (!security || !step || step.quantity <= 0) continue;
      const quantity = fixed(step.quantity);
      const cost = minor(step.cost);

      const market = latestAt(prices.get(id) ?? [], date);
      const useTrade = !market || market.date < step.date;
      const price = useTrade ? step.tradePrice : market.price;
      const priceDate = useTrade ? step.date : market.date;
      const priceSource: Position["priceSource"] = useTrade
        ? "trade"
        : market.source === "manual"
          ? "manual"
          : "provider";

      const fx = fxAt(security.currency, date);
      const value = fx
        ? valueOf(quantity, price, fx.rate, input.accountCurrency, fx.inverse)
        : cost;
      positions.push({
        securityId: id,
        name: security.name,
        currency: security.currency,
        quantity,
        price,
        priceDate,
        priceSource,
        fxRate: fx ? (fx.inverse ? invertFixed(fx.rate) : fx.rate) : null,
        value,
        cost,
        gain: minor(value - cost),
        estimated: fx === null,
      });
    }
    positions.sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : a.securityId < b.securityId
            ? -1
            : 1,
    );
    return {
      value: minor(positions.reduce((sum, p) => sum + p.value, 0)),
      cost: minor(positions.reduce((sum, p) => sum + p.cost, 0)),
      positions,
      estimated: positions.some((p) => p.estimated),
    };
  };
}

export function holdingsValueAt(
  input: HoldingsInput,
  date: string,
): HoldingsValue {
  return makeHoldingsValueAt(input)(date);
}

/**
 * First date on which the running quantity of a security's trades goes
 * negative, or null. Buys apply before sells on the same date.
 */
export function firstOversell(
  trades: readonly { date: string; side: TradeSide; quantity: number }[],
): string | null {
  const sorted = [...trades].sort(compareTrades);
  let held = 0;
  for (const t of sorted) {
    held += t.side === "buy" ? t.quantity : -t.quantity;
    if (held < 0) return t.date;
  }
  return null;
}
