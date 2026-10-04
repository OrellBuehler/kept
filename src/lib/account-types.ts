import type { AccountType } from "$lib/ledger-types";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  current: "Current",
  savings: "Savings",
  credit_card: "Credit card",
  investment: "Investment",
  pension: "Pension",
  pillar_3a: "Pillar 3a",
  cash: "Cash",
  other: "Other",
};

export const COMMON_CURRENCIES = ["CHF", "EUR", "USD", "GBP"] as const;

export const COLOR_PALETTE = [
  "#2563eb",
  "#0891b2",
  "#059669",
  "#65a30d",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#7c3aed",
  "#64748b",
] as const;
