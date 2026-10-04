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

/** Account types a withdrawal notice can apply to. */
export const NOTICE_ACCOUNT_TYPES: readonly AccountType[] = [
  "current",
  "savings",
  "cash",
  "other",
];

export const WITHDRAWAL_PERIODS = ["month", "year"] as const;
export type WithdrawalPeriod = (typeof WITHDRAWAL_PERIODS)[number];

export const IMPORT_FORMATS = ["camt053", "csv", "xlsx"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** `mirror`: a counter-transaction Kept created from a transfer on another account. */
export const ROW_SOURCES = ["manual", "import", "mirror"] as const;
export type RowSource = (typeof ROW_SOURCES)[number];

export const REFERENCE_TYPES = ["QRR", "SCOR"] as const;

export const TRANSFER_STATUSES = [
  "linked",
  "needs_amount",
  "dismissed",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_METHODS = ["paired", "mirrored", "manual"] as const;
export type TransferMethod = (typeof TRANSFER_METHODS)[number];

/**
 * What undoing an import would delete besides the imported rows themselves:
 * edits the user made on those rows. Counts are of transactions (links and
 * mirrors: of rows). A category cannot be told apart as set by a rule or by
 * hand, so every category on those rows is counted.
 */
export interface ImportImpact {
  transactions: number;
  categorized: number;
  notes: number;
  taxYears: number;
  deductionYears: number;
  billAllocations: number;
  pillar3a: number;
  transferLinks: number;
  mirrors: number;
}
