/** Shared (client-safe) bill enums. The database schema re-exports these. */
export const BILL_KINDS = ["invoice", "credit_note"] as const;
export type BillKind = (typeof BILL_KINDS)[number];

export const BILL_REFERENCE_TYPES = ["QRR", "SCOR", "NON"] as const;
export type BillReferenceType = (typeof BILL_REFERENCE_TYPES)[number];

export const DOCUMENT_SOURCES = ["upload", "integration"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const ALLOCATION_ORIGINS = ["auto", "user"] as const;
export type AllocationOrigin = (typeof ALLOCATION_ORIGINS)[number];

export const BILL_STATUSES = [
  "open",
  "paid",
  "overpaid",
  "partially_paid",
  "credit_due",
  "cancelled",
] as const;
export type BillStatusName = (typeof BILL_STATUSES)[number];
