/** Shared (client-safe) ledger enums. The database schema re-exports these. */
export const ACCOUNT_TYPES = [
  "current",
  "savings",
  "credit_card",
  "investment",
  "pension",
  "pillar_3a",
  "cash",
  "other",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const IMPORT_FORMATS = ["camt053", "csv", "xlsx"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const ROW_SOURCES = ["manual", "import"] as const;
export type RowSource = (typeof ROW_SOURCES)[number];

export const REFERENCE_TYPES = ["QRR", "SCOR"] as const;
