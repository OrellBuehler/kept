/** Shared (client-safe) investment enums. The database schema re-exports these. */
export const SECURITY_KINDS = [
  "etf",
  "stock",
  "fund",
  "bond",
  "other",
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

export const TRADE_SIDES = ["buy", "sell"] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export const PRICE_SOURCES = ["manual", "provider"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];
