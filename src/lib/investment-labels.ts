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
