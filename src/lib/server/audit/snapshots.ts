/**
 * The shape an entity takes in the change log. One function per entity, used
 * both when a change is recorded and when a revert compares the current state
 * with what the entry says it left behind, so the two cannot drift apart.
 * Values only: minor units, `YYYY-MM-DD` strings, epoch milliseconds, ids.
 * Anything missing is `null`, never `undefined`.
 */
import type { BillView } from "$lib/server/bills/bills";
import type { Snapshot } from "./types";

/** Editable fields of a bill (no `createdAt`/`updatedAt`): what an update diffs. */
export function billFields(bill: BillView): Snapshot {
  return {
    kind: bill.kind,
    creditorName: bill.creditorName,
    creditorIban: bill.creditorIban,
    amount: bill.amount,
    currency: bill.currency,
    issueDate: bill.issueDate,
    dueDate: bill.dueDate,
    reference: bill.reference,
    referenceType: bill.referenceType,
    message: bill.message,
    invoiceNumber: bill.invoiceNumber,
    cancelled: bill.cancelled,
    documentId: bill.documentId,
    expectedAccountId: bill.expectedAccountId,
    notes: bill.notes,
    taxYear: bill.taxYear,
    externalSource: bill.externalSource,
    externalRef: bill.externalRef,
    externalUrl: bill.externalUrl,
    extraction: bill.extraction,
  };
}

/** A whole bill, for a create or a delete (a revert of the delete restores `createdAt` too). */
export function billSnapshot(bill: BillView): Snapshot {
  return { ...billFields(bill), createdAt: bill.createdAt };
}

export interface AllocationData {
  billId: string;
  transactionId: string;
  amount: number;
  origin: string;
  createdAt?: number;
}

export function allocationSnapshot(a: AllocationData): Snapshot {
  const out: Snapshot = {
    billId: a.billId,
    transactionId: a.transactionId,
    amount: a.amount,
    origin: a.origin,
  };
  if (a.createdAt !== undefined) out.createdAt = a.createdAt;
  return out;
}

export function dismissalSnapshot(d: {
  billId: string;
  transactionId: string;
}): Snapshot {
  return { billId: d.billId, transactionId: d.transactionId };
}

export function categoryFields(c: {
  name: string;
  parentId: string | null;
  kind: string;
  color: string | null;
  icon: string | null;
}): Snapshot {
  return {
    name: c.name,
    parentId: c.parentId,
    kind: c.kind,
    color: c.color,
    icon: c.icon,
  };
}

export function ruleFields(r: {
  categoryId: string;
  priority: number;
  counterpartyContains: string | null;
  descriptionContains: string | null;
  counterpartyIban: string | null;
  amountSign: string | null;
}): Snapshot {
  return {
    categoryId: r.categoryId,
    priority: r.priority,
    counterpartyContains: r.counterpartyContains,
    descriptionContains: r.descriptionContains,
    counterpartyIban: r.counterpartyIban,
    amountSign: r.amountSign,
  };
}

/** Fields of a transaction that a revert can restore. */
export const REVERTIBLE_TRANSACTION_FIELDS = [
  "note",
  "categoryId",
  "taxYear",
  "deductionYear",
  "deductionExcluded",
] as const;

export type TransactionFieldName =
  (typeof REVERTIBLE_TRANSACTION_FIELDS)[number];

/** Short text for the `summary` of a transaction entry: the counterparty, else the start of the description. */
export function transactionSummary(t: {
  counterpartyName: string | null;
  description: string | null;
}): string | null {
  const text = t.counterpartyName ?? t.description;
  if (text === null) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** The named fields of a row, `undefined` as `null`: a snapshot of a simple entity. */
export function pick<T extends object, K extends keyof T & string>(
  row: T,
  keys: readonly K[],
): Snapshot {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}
