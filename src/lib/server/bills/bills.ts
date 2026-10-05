import { and, asc, count, desc, eq, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { BillKind, BillReferenceType } from "$lib/bill-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  billAllocations,
  bills,
  documents,
  first,
  getDB,
  isUniqueViolation,
  type DB,
  afterCommit,
  transaction,
} from "$lib/server/db";
import { emitBillChanged } from "$lib/server/events";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { deleteDocumentWhere } from "./documents";
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

/**
 * The one lock every transaction takes that changes what an allocation check
 * reads (a bill's amount, kind, currency or cancellation, or the allocations
 * themselves). One key per user; never take a different lock in the same
 * transaction.
 */
export const billsLock = (userId: string) => ({
  lock: `bills:${userId}`,
});

function ownedBillQuery(tx: Pick<DB, "select">, userId: string, id: string) {
  return tx
    .select()
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.id, id)));
}

export async function getBill(userId: string, id: string): Promise<BillView> {
  const row = await first(ownedBillQuery(getDB(), userId, id).limit(1));
  if (!row) throw notFound("Bill");
  return toView(row);
}

/** `getBill` on a transaction you already hold. */
export async function getBillInTx(
  tx: Pick<DB, "select">,
  userId: string,
  id: string,
): Promise<BillView> {
  const row = await first(ownedBillQuery(tx, userId, id).limit(1));
  if (!row) throw notFound("Bill");
  return toView(row);
}

/** All of the user's bills, newest first. */
export async function listBills(userId: string): Promise<BillView[]> {
  const rows = await getDB()
    .select()
    .from(bills)
    .where(eq(bills.userId, userId))
    .orderBy(desc(bills.createdAt), asc(bills.id));
  return rows.map(toView);
}

/** `listBills` on a transaction you already hold. */
export async function listBillsInTx(
  tx: Pick<DB, "select">,
  userId: string,
): Promise<BillView[]> {
  return (
    await tx
      .select()
      .from(bills)
      .where(eq(bills.userId, userId))
      .orderBy(desc(bills.createdAt), asc(bills.id))
  ).map(toView);
}

async function assertOwnedAccountInTx(
  tx: Pick<DB, "select">,
  userId: string,
  accountId: string | null,
) {
  if (accountId === null) return;
  const found = await first(
    tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!found) {
    throw new LedgerError(
      "invalid",
      "Choose one of your accounts.",
      "expectedAccountId",
    );
  }
}

async function assertOwnedDocumentInTx(
  tx: Pick<DB, "select">,
  userId: string,
  documentId: string | null,
) {
  if (documentId === null) return;
  const found = await first(
    tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
      .limit(1),
  );
  if (!found) throw notFound("Document");
}

/**
 * Ownership checks and the insert share one transaction. A duplicate external
 * reference is caught by the unique (user, source, ref) index rather than by a
 * read beforehand, so two concurrent imports cannot both pass.
 */
export async function createBill(
  userId: string,
  input: BillInput,
  options: {
    documentId?: string | null;
    extraction?: BillExtractionMeta | null;
    external?: BillExternal;
  } = {},
): Promise<BillView> {
  const ext = options.external;
  let view: BillView;
  try {
    view = await transaction(async (tx) => {
      await assertOwnedAccountInTx(tx, userId, input.expectedAccountId);
      await assertOwnedDocumentInTx(tx, userId, options.documentId ?? null);
      const row = (await first(
        tx
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
          .returning(),
      ))!;
      return toView(row);
    });
  } catch (err) {
    if (ext && isUniqueViolation(err)) {
      throw new LedgerError("conflict", "This bill was already imported.");
    }
    throw err;
  }
  afterCommit(() => emitBillChanged(userId, view.id));
  return view;
}

async function allocationCountInTx(
  tx: Pick<DB, "select">,
  userId: string,
  billId: string,
): Promise<number> {
  return (await first(
    tx
      .select({ n: count() })
      .from(billAllocations)
      .where(
        and(
          eq(billAllocations.userId, userId),
          eq(billAllocations.billId, billId),
        ),
      )
      .limit(1),
  ))!.n;
}

/**
 * Updates the editable fields. Kind and currency are fixed once payments are
 * allocated, because allocations are signed and checked in the bill's direction.
 * The allocation check and the update share one transaction.
 */
export async function updateBill(
  userId: string,
  id: string,
  input: BillInput,
): Promise<BillView> {
  const view = await transaction(async (tx) => {
    const current = await getBillInTx(tx, userId, id);
    await assertOwnedAccountInTx(tx, userId, input.expectedAccountId);
    if (
      (input.kind !== current.kind || input.currency !== current.currency) &&
      (await allocationCountInTx(tx, userId, id)) > 0
    ) {
      throw new LedgerError(
        "conflict",
        "Remove the allocated payments before changing the type or currency.",
        input.kind !== current.kind ? "kind" : "currency",
      );
    }
    const row = await first(
      tx
        .update(bills)
        .set(input)
        .where(and(eq(bills.userId, userId), eq(bills.id, id)))
        .returning(),
    );
    if (!row) throw notFound("Bill");
    return toView(row);
  }, billsLock(userId));
  afterCommit(() => emitBillChanged(userId, id));
  return view;
}

/**
 * Deletes an uploaded document that no bill references any more. The reference
 * check is part of the delete statement, so a bill attached in the meantime
 * keeps its document.
 */
export async function deleteDocumentIfUnused(
  userId: string,
  documentId: string | null,
): Promise<boolean> {
  if (documentId === null) return false;
  return deleteDocumentWhere(
    userId,
    documentId,
    and(
      eq(documents.source, "upload"),
      notExists(
        getDB()
          .select({ one: sql`1` })
          .from(bills)
          .where(eq(bills.documentId, documents.id)),
      ),
    ),
  );
}

/** Deletes the bill, its allocations (cascade) and its uploaded document when nothing else uses it. */
export async function deleteBill(userId: string, id: string): Promise<void> {
  // Allocation checks read the bill and cascade away with it: the delete takes
  // the same lock as them, so an allocation cannot be mid-insert against it.
  const [deleted] = await transaction(
    async (tx) =>
      await tx
        .delete(bills)
        .where(and(eq(bills.userId, userId), eq(bills.id, id)))
        .returning({ documentId: bills.documentId }),
    billsLock(userId),
  );
  if (!deleted) throw notFound("Bill");
  await deleteDocumentIfUnused(userId, deleted.documentId);
}

export async function setBillCancelled(
  userId: string,
  id: string,
  cancelled: boolean,
): Promise<BillView> {
  // Cancelling decides whether an allocation may be added, so it takes the
  // same lock as the allocation check.
  const row = await transaction(async (tx) => {
    const [updated] = await tx
      .update(bills)
      .set({ cancelled })
      .where(and(eq(bills.userId, userId), eq(bills.id, id)))
      .returning();
    if (!updated) throw notFound("Bill");
    afterCommit(() => emitBillChanged(userId, id));
    return updated;
  }, billsLock(userId));
  return toView(row);
}

export const cancelBill = (userId: string, id: string) =>
  setBillCancelled(userId, id, true);
export const uncancelBill = (userId: string, id: string) =>
  setBillCancelled(userId, id, false);

/** Attaches a stored document; an uploaded document replaced by this one is removed if unused. */
export async function attachDocument(
  userId: string,
  billId: string,
  documentId: string,
): Promise<BillView> {
  const { view, previous } = await transaction(async (tx) => {
    const current = await getBillInTx(tx, userId, billId);
    await assertOwnedDocumentInTx(tx, userId, documentId);
    const row = await first(
      tx
        .update(bills)
        .set({ documentId })
        .where(and(eq(bills.userId, userId), eq(bills.id, billId)))
        .returning(),
    );
    if (!row) throw notFound("Bill");
    return { view: toView(row), previous: current.documentId };
  });
  if (previous !== null && previous !== documentId) {
    await deleteDocumentIfUnused(userId, previous);
  }
  return view;
}

export async function setBillExtraction(
  userId: string,
  billId: string,
  extraction: BillExtractionMeta,
): Promise<void> {
  const updated = await getDB()
    .update(bills)
    .set({ extraction: JSON.stringify(extraction) })
    .where(and(eq(bills.userId, userId), eq(bills.id, billId)))
    .returning({ id: bills.id });
  if (updated.length === 0) throw notFound("Bill");
}

export const DOCUMENT_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the user's uploaded documents that no bill references and that are
 * older than a day (abandoned uploads). Returns how many were removed.
 */
export async function sweepUnreferencedDocuments(
  userId: string,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - DOCUMENT_SWEEP_AGE_MS);
  const stale = await getDB()
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
    );
  // deleteDocumentIfUnused re-checks the reference inside its delete, so a bill
  // attached since the query above keeps its document.
  let removed = 0;
  for (const d of stale) {
    if (await deleteDocumentIfUnused(userId, d.id)) removed++;
  }
  return removed;
}
