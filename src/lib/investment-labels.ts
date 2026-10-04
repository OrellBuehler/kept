import type {
  PriceSource,
  SecurityKind,
  TradeSide,
} from "$lib/investment-types";

export const SECURITY_KIND_LABELS: Record<SecurityKind, string> = {
  etf: "ETF",
  stock: "Stock",
  fund: "Fund",
  bond: "Bond",
  other: "Other",
};

export const TRADE_SIDE_LABELS: Record<TradeSide, string> = {
  buy: "Buy",
  sell: "Sell",
  split: "Split",
};

/** Where a position's price comes from; "trade" is the fallback to the last trade price. */
export const PRICE_SOURCE_LABELS: Record<PriceSource | "trade", string> = {
  manual: "manual",
  provider: "fetched",
  trade: "last trade",
};

/**
 * The `new : old` terms of a split for display and for editing. Splits entered as a plain
 * ratio are shown as whole numbers when the ratio is one (2 -> 2 : 1, 0.1 -> 1 : 10);
 * otherwise null.
 */
export function splitTerms(split: {
  quantity: number;
  splitNew: number | null;
  splitOld: number | null;
}): { new: number; old: number } | null {
  if (split.splitNew && split.splitOld) {
    return { new: split.splitNew, old: split.splitOld };
  }
  const scale = 100_000_000;
  if (split.quantity >= scale && split.quantity % scale === 0) {
    return { new: split.quantity / scale, old: 1 };
  }
  const inverse = scale / split.quantity;
  if (split.quantity > 0 && Number.isInteger(inverse)) {
    return { new: 1, old: inverse };
  }
  return null;
}
