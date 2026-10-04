/** Shared (client-safe) investment enums. The database schema re-exports these. */
export const SECURITY_KINDS = [
  "etf",
  "stock",
  "fund",
  "bond",
  "other",
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

/**
 * A `split` is a corporate action, not a cash movement: `splitNew : splitOld`
 * are the exact integer ratio of new to old shares (2:1, or 1:10 for a reverse
 * split), `quantity` its Fixed8 approximation (2, 0.1), and `price` and
 * `amount` are 0. It applies at the start of its date.
 */
export const TRADE_SIDES = ["buy", "sell", "split"] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export const PRICE_SOURCES = ["manual", "provider"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];
