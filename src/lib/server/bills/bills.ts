import { and, asc, count, desc, eq, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { BillKind, BillReferenceType } from "$lib/bill-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  billAllocations,
  bills,
  documents,
  getDB,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { deleteDocument } from "./documents";
import type { MatchBill } from "./matching";
import type { BillInput } from "./schemas";

export interface BillExtractionMeta {
  source: "qr" | "text" | "none";
  warnings: string[];
}

export interface BillView {
  id: string;
  kind: BillKind;
  creditorName: string | null;
  creditorIban: string | null;
  amount: Minor | null;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  reference: string | null;
  referenceType: BillReferenceType | null;
  message: string | null;
  invoiceNumber: string | null;
  cancelled: boolean;
  documentId: string | null;
  expectedAccountId: string | null;
  notes: string | null;
  taxYear: number | null;
  externalSource: string | null;
  externalRef: string | null;
  externalUrl: string | null;
  extraction: BillExtractionMeta | null;
  createdAt: number;
  updatedAt: number;
}

export interface BillExternal {
  externalSource: string;
  externalRef: string;
  externalUrl?: string | null;
}

const extractionSchema = z.object({
  source: z.enum(["qr", "text", "none"]),
  warnings: z.array(z.string()),
});

type Row = typeof bills.$inferSelect;

function parseExtraction(raw: string | null): BillExtractionMeta | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn("bill extraction metadata is not valid JSON");
    return null;
  }
  const parsed = extractionSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function toView(row: Row): BillView {
  return {
    id: row.id,
    kind: row.kind,
    creditorName: row.creditorName,
    creditorIban: row.creditorIban,
    amount: row.amount,
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    reference: row.reference,
    referenceType: row.referenceType,
    message: row.message,
    invoiceNumber: row.invoiceNumber,
    cancelled: row.cancelled,
    documentId: row.documentId,
    expectedAccountId: row.expectedAccountId,
    notes: row.notes,
    taxYear: row.taxYear,
    externalSource: row.externalSource,
    externalRef: row.externalRef,
    externalUrl: row.externalUrl,
    extraction: parseExtraction(row.extraction),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toMatchBill(bill: BillView): MatchBill {
  return {
    id: bill.id,
    kind: bill.kind,
    currency: bill.currency,
    amount: bill.amount,
    issueDate: bill.issueDate,
    dueDate: bill.dueDate,
    reference: bill.reference,
    referenceType: bill.referenceType,
    creditorIban: bill.creditorIban,
    creditorName: bill.creditorName,
    cancelled: bill.cancelled,
  };
}

export function getBill(userId: string, id: string): BillView {
  const row = getDB()
    .select()
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.id, id)))
    .get();
  if (!row) throw notFound("Bill");
  return toView(row);
}

/** All of the user's bills, newest first. */
export function listBills(userId: string): BillView[] {
  return getDB()
    .select()
    .from(bills)
    .where(eq(bills.userId, userId))
    .orderBy(desc(bills.createdAt), asc(bills.id))
    .all()
    .map(toView);
}

function assertOwnedAccount(userId: string, accountId: string | null) {
  if (accountId === null) return;
  const found = getDB()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!found) {
    throw new LedgerError(
      "invalid",
      "Choose one of your accounts.",
      "expectedAccountId",
    );
  }
}

function assertOwnedDocument(userId: string, documentId: string | null) {
  if (documentId === null) return;
  const found = getDB()
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
    .get();
  if (!found) throw notFound("Document");
}

export function createBill(
  userId: string,
  input: BillInput,
  options: {
    documentId?: string | null;
    extraction?: BillExtractionMeta | null;
    external?: BillExternal;
  } = {},
): BillView {
  assertOwnedAccount(userId, input.expectedAccountId);
  assertOwnedDocument(userId, options.documentId ?? null);
  const ext = options.external;
  if (ext) {
    const dup = getDB()
      .select({ id: bills.id })
      .from(bills)
      .where(
        and(
          eq(bills.userId, userId),
          eq(bills.externalSource, ext.externalSource),
          eq(bills.externalRef, ext.externalRef),
        ),
      )
      .get();
    if (dup) {
      throw new LedgerError("conflict", "This bill was already imported.");
    }
  }
  const row = getDB()
    .insert(bills)
    .values({
      ...input,
      userId,
      documentId: options.documentId ?? null,
      externalSource: ext?.externalSource ?? null,
      externalRef: ext?.externalRef ?? null,
      externalUrl: ext?.externalUrl ?? null,
      extraction: options.extraction
        ? JSON.stringify(options.extraction)
        : null,
    })
    .returning({ id: bills.id })
    .get();
  return getBill(userId, row.id);
}

function allocationCount(userId: string, billId: string): number {
  return getDB()
    .select({ n: count() })
    .from(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        eq(billAllocations.billId, billId),
      ),
    )
    .get()!.n;
}

/**
 * Updates the editable fields. Kind and currency are fixed once payments are
 * allocated, because allocations are signed and checked in the bill's direction.
 */
export function updateBill(
  userId: string,
  id: string,
  input: BillInput,
): BillView {
  const current = getBill(userId, id);
  assertOwnedAccount(userId, input.expectedAccountId);
  if (
    (input.kind !== current.kind || input.currency !== current.currency) &&
    allocationCount(userId, id) > 0
  ) {
    throw new LedgerError(
      "conflict",
      "Remove the allocated payments before changing the type or currency.",
      input.kind !== current.kind ? "kind" : "currency",
    );
  }
  getDB()
    .update(bills)
    .set(input)
    .where(and(eq(bills.userId, userId), eq(bills.id, id)))
    .run();
  return getBill(userId, id);
}

function documentReferenced(userId: string, documentId: string): boolean {
  return (
    getDB()
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.userId, userId), eq(bills.documentId, documentId)))
      .get() !== undefined
  );
}

/** Deletes an uploaded document that no bill references any more. */
export function deleteDocumentIfUnused(
  userId: string,
  documentId: string | null,
) {
  if (documentId === null || documentReferenced(userId, documentId)) return;
  const row = getDB()
    .select({ source: documents.source })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
    .get();
  if (row?.source === "upload") deleteDocument(userId, documentId);
}

/** Deletes the bill, its allocations (cascade) and its uploaded document when nothing else uses it. */
export function deleteBill(userId: string, id: string): void {
  const current = getBill(userId, id);
  getDB()
    .delete(bills)
    .where(and(eq(bills.userId, userId), eq(bills.id, id)))
    .run();
  deleteDocumentIfUnused(userId, current.documentId);
}

export function setBillCancelled(
  userId: string,
  id: string,
  cancelled: boolean,
): BillView {
  getBill(userId, id);
  getDB()
    .update(bills)
    .set({ cancelled })
    .where(and(eq(bills.userId, userId), eq(bills.id, id)))
    .run();
  return getBill(userId, id);
}

export const cancelBill = (userId: string, id: string) =>
  setBillCancelled(userId, id, true);
export const uncancelBill = (userId: string, id: string) =>
  setBillCancelled(userId, id, false);

/** Attaches a stored document; an uploaded document replaced by this one is removed if unused. */
export function attachDocument(
  userId: string,
  billId: string,
  documentId: string,
): BillView {
  const current = getBill(userId, billId);
  assertOwnedDocument(userId, documentId);
  getDB()
    .update(bills)
    .set({ documentId })
    .where(and(eq(bills.userId, userId), eq(bills.id, billId)))
    .run();
  if (current.documentId !== null && current.documentId !== documentId) {
    deleteDocumentIfUnused(userId, current.documentId);
  }
  return getBill(userId, billId);
}

export function setBillExtraction(
  userId: string,
  billId: string,
  extraction: BillExtractionMeta,
): void {
  getBill(userId, billId);
  getDB()
    .update(bills)
    .set({ extraction: JSON.stringify(extraction) })
    .where(and(eq(bills.userId, userId), eq(bills.id, billId)))
    .run();
}

export const DOCUMENT_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the user's uploaded documents that no bill references and that are
 * older than a day (abandoned uploads). Returns how many were removed.
 */
export function sweepUnreferencedDocuments(
  userId: string,
  now: number = Date.now(),
): number {
  const cutoff = new Date(now - DOCUMENT_SWEEP_AGE_MS);
  const stale = getDB()
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "upload"),
        lt(documents.createdAt, cutoff),
        notExists(
          getDB()
            .select({ one: sql`1` })
            .from(bills)
            .where(eq(bills.documentId, documents.id)),
        ),
      ),
    )
    .all();
  for (const d of stale) deleteDocument(userId, d.id);
  return stale.length;
}
