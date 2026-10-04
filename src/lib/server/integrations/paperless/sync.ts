import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { autoMatchQuietly } from "$lib/server/bills/auto-match";
import {
  attachDocument,
  createBill,
  getBill,
  type BillView,
} from "$lib/server/bills/bills";
import { billFromExtraction, pdfErrorMessage } from "$lib/server/bills/draft";
import {
  deleteDocument,
  getDocumentMeta,
  hasPdfMagic,
  storeDocument,
} from "$lib/server/bills/documents";
import {
  PdfExtractError,
  extractBillFromPdf,
  type BillExtraction,
} from "$lib/server/bills/pdf-extract";
import { billInputSchema, type BillInput } from "$lib/server/bills/schemas";
import {
  bills,
  getDB,
  paperlessDocuments,
  paperlessPending,
} from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import type { PaperlessBillSource } from "$lib/server/db";
import {
  PaperlessClient,
  PaperlessError,
  errorCode,
  isTransientError,
} from "./client";
import {
  clientForRow,
  rowExternalRef,
  getConnectionRow,
  isDismissed,
  recordConnectionState,
  rememberServerInfo,
  requireConnectionRow,
  type ConnectionRow,
} from "./connection";
import { pushBillSafely } from "./push";
import { savedViewRuleSchema, translateFilterRules } from "./saved-views";

export { externalRef, instanceKey } from "./connection";

export const EXTERNAL_SOURCE = "paperless";
export const REVIEW_NOTE = "Imported from Paperless — please check.";
/** Documents modified within this window before the watermark are looked at again. */
export const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
/** A document Paperless cannot serve is retried this many times, or for this long, before it is marked failed. */
export const MAX_DOCUMENT_ATTEMPTS = 5;
export const MAX_DOCUMENT_RETRY_MS = 24 * 60 * 60 * 1000;
/** This many downloads in a row failing to connect, without any success in between, mean the connection is down. */
const NETWORK_STREAK_LIMIT = 3;
const PAGE_SIZE = 100;
const FIELDS = "id,modified,mime_type,original_file_name,archived_file_name";

const docSchema = z.object({
  id: z.number().int(),
  modified: z.string(),
  mime_type: z.string().nullish(),
  original_file_name: z.string().nullish(),
  archived_file_name: z.string().nullish(),
});
type PaperlessDoc = z.output<typeof docSchema>;

const savedViewSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  filter_rules: z.array(savedViewRuleSchema).default([]),
});

export interface SyncResult {
  listed: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** Documents Paperless could not serve right now (5xx, 429, timeout); retried on the next run. */
  pending: number;
  /** Requested document ids Paperless does not (yet) show; the webhook retries these. */
  missing: number[];
  /** Connection-level failure (a short code), when the run was cut short. */
  error: string | null;
}

export interface SyncOptions {
  documentIds?: number[];
}

const emptyResult = (): SyncResult => ({
  listed: 0,
  imported: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  pending: 0,
  missing: [],
  error: null,
});

type Outcome = "imported" | "updated" | "unchanged" | "skipped" | "failed";

class SourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function sourceQuery(
  client: PaperlessClient,
  source: PaperlessBillSource,
): Promise<Array<[string, string]>> {
  if (source.kind === "tag") return [["tags__id__all", String(source.id)]];
  let view: z.output<typeof savedViewSchema>;
  try {
    view = await client.json(`saved_views/${source.id}`, savedViewSchema);
  } catch (err) {
    if (err instanceof PaperlessError && err.code === "not_found") {
      throw new SourceError("source_missing");
    }
    throw err;
  }
  const t = translateFilterRules(view.filter_rules);
  if (!t.ok) throw new SourceError("source_unsupported");
  return t.query;
}

function parseModified(doc: PaperlessDoc): number {
  const ms = Date.parse(doc.modified);
  if (!Number.isFinite(ms)) {
    throw new PaperlessError("invalid_response", { detail: "bad date" });
  }
  return ms;
}

// One sync per connection at a time; later requests queue behind it.
const chains = new Map<string, Promise<unknown>>();

export function isSyncing(connectionId: string): boolean {
  return chains.has(connectionId);
}

export async function syncConnection(
  userId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const row = requireConnectionRow(userId);
  const previous = chains.get(row.id) ?? Promise.resolve();
  const run = () => runSync(userId, row.id, options);
  const tail = previous.then(run, run);
  chains.set(row.id, tail);
  void tail
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (chains.get(row.id) === tail) chains.delete(row.id);
    });
  return tail;
}

async function runSync(
  userId: string,
  connectionId: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const row = getConnectionRow(userId);
  if (!row || row.id !== connectionId) {
    throw new LedgerError("not_found", "Paperless connection not found.");
  }
  const result = emptyResult();
  const client = clientForRow(row);
  try {
    await sync(userId, row, client, options, result);
  } catch (err) {
    const code =
      err instanceof SourceError
        ? err.code
        : err instanceof PaperlessError
          ? err.code
          : null;
    if (code === null) throw err;
    console.error("paperless sync stopped", code);
    result.error = code;
  }
  // New or changed bills may match payments that are already booked.
  if (result.imported + result.updated > 0) autoMatchQuietly(userId);
  rememberServerInfo(row, client);
  recordConnectionState(row, {
    lastError: result.error,
    lastSyncAt: new Date(),
  });
  return result;
}

async function sync(
  userId: string,
  row: ConnectionRow,
  client: PaperlessClient,
  options: SyncOptions,
  result: SyncResult,
): Promise<void> {
  if (!row.billSource) throw new SourceError("no_source");
  const base = await sourceQuery(client, row.billSource);

  const state: RunState = { networkStreak: [] };
  if (options.documentIds) {
    const ids = [...new Set(options.documentIds)];
    const visible: number[] = [];
    for (const id of ids) {
      try {
        await client.json(`documents/${id}`, docSchema, {
          query: { fields: FIELDS },
        });
        visible.push(id);
      } catch (err) {
        if (
          err instanceof PaperlessError &&
          (err.code === "not_found" || err.code === "forbidden")
        ) {
          result.missing.push(id);
        } else throw err;
      }
    }
    if (visible.length === 0) return;
    const query: Array<[string, string]> = [
      ...base,
      ["id__in", visible.join(",")],
      ["page_size", String(PAGE_SIZE)],
      ["fields", FIELDS],
    ];
    for await (const page of client.pages("documents", query, docSchema)) {
      for (const doc of page) {
        await handle(userId, row, client, doc, result, state);
      }
    }
    return;
  }

  const query: Array<[string, string]> = [
    ...base,
    ["ordering", "modified"],
    ["page_size", String(PAGE_SIZE)],
    ["fields", FIELDS],
  ];
  if (row.lastSyncModified !== null) {
    query.push([
      "modified__gt",
      new Date(row.lastSyncModified - WATERMARK_OVERLAP_MS).toISOString(),
    ]);
  }
  let highWater = row.lastSyncModified;
  let held = false;
  try {
    for await (const page of client.pages("documents", query, docSchema)) {
      for (const doc of page) {
        const pendingBefore = result.pending;
        await handle(userId, row, client, doc, result, state);
        // A document left pending keeps the watermark in front of it.
        if (result.pending > pendingBefore) held = true;
        if (held) continue;
        const ms = parseModified(doc);
        if (highWater === null || ms > highWater) highWater = ms;
      }
    }
  } finally {
    // Only documents that were handled move the watermark; a halted run retries the rest.
    if (highWater !== row.lastSyncModified) {
      recordConnectionState(row, { lastSyncModified: highWater });
    }
  }
}

function findLink(row: ConnectionRow, paperlessId: number) {
  return (
    getDB()
      .select()
      .from(paperlessDocuments)
      .where(
        and(
          eq(paperlessDocuments.userId, row.userId),
          eq(paperlessDocuments.connectionId, row.id),
          eq(paperlessDocuments.paperlessId, paperlessId),
        ),
      )
      .get() ?? null
  );
}

interface LinkValues {
  modified: number;
  status: "imported" | "skipped" | "failed";
  error?: string | null;
  billId?: string | null;
  documentId?: string | null;
  contentSha256?: string | null;
}

function saveLink(row: ConnectionRow, paperlessId: number, v: LinkValues) {
  const set = {
    modified: v.modified,
    status: v.status,
    error: v.error ?? null,
    ...(v.billId !== undefined ? { billId: v.billId } : {}),
    ...(v.documentId !== undefined ? { documentId: v.documentId } : {}),
    ...(v.contentSha256 !== undefined
      ? { contentSha256: v.contentSha256 }
      : {}),
  };
  getDB()
    .insert(paperlessDocuments)
    .values({
      userId: row.userId,
      connectionId: row.id,
      paperlessId,
      billId: v.billId ?? null,
      documentId: v.documentId ?? null,
      contentSha256: v.contentSha256 ?? null,
      ...set,
    })
    .onConflictDoUpdate({
      target: [paperlessDocuments.connectionId, paperlessDocuments.paperlessId],
      set,
    })
    .run();
}

function touchModified(link: { id: string }, userId: string, modified: number) {
  getDB()
    .update(paperlessDocuments)
    .set({ modified })
    .where(
      and(
        eq(paperlessDocuments.userId, userId),
        eq(paperlessDocuments.id, link.id),
      ),
    )
    .run();
}

function findBillByRef(userId: string, ref: string): BillView | null {
  const found = getDB()
    .select({ id: bills.id })
    .from(bills)
    .where(
      and(
        eq(bills.userId, userId),
        eq(bills.externalSource, EXTERNAL_SOURCE),
        eq(bills.externalRef, ref),
      ),
    )
    .get();
  return found ? getBill(userId, found.id) : null;
}

/** Deletes a stored integration document once nothing refers to it any more. */
function releaseDocument(userId: string, documentId: string | null): void {
  if (documentId === null) return;
  const db = getDB();
  const usedByBill = db
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.documentId, documentId)))
    .get();
  const usedByLink = db
    .select({ id: paperlessDocuments.id })
    .from(paperlessDocuments)
    .where(
      and(
        eq(paperlessDocuments.userId, userId),
        eq(paperlessDocuments.documentId, documentId),
      ),
    )
    .get();
  if (usedByBill || usedByLink) return;
  if (getDocumentMeta(userId, documentId).source === "integration") {
    deleteDocument(userId, documentId);
  }
}

const BLANKABLE = [
  "amount",
  "reference",
  "referenceType",
  "creditorIban",
  "dueDate",
  "issueDate",
  "message",
  "invoiceNumber",
] as const;

type Built =
  | { ok: true; input: BillInput; review: boolean }
  | { ok: false; reason: string };

/** Turns an extraction draft into a bill input, dropping fields that do not validate. */
function buildBillInput(draft: Record<string, string>): Built {
  const form: Record<string, string> = {
    ...draft,
    expectedAccountId: "",
    notes: "",
    taxYear: "",
  };
  let dropped = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parsed = billInputSchema.safeParse(form);
    if (parsed.success) {
      const input = parsed.data;
      const incomplete = input.amount === null && input.reference === null;
      const review = incomplete || dropped;
      return {
        ok: true,
        review,
        input: review ? { ...input, notes: REVIEW_NOTE } : input,
      };
    }
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    if (fields.has("creditorName") || fields.has("kind")) {
      return {
        ok: false,
        reason: "No creditor name or IBAN was found in the document.",
      };
    }
    const toBlank = BLANKABLE.filter((f) => fields.has(f) && form[f] !== "");
    if (toBlank.length === 0) {
      return { ok: false, reason: "The document data is not a valid bill." };
    }
    for (const f of toBlank) form[f] = "";
    if (fields.has("reference")) form.referenceType = "";
    dropped = true;
  }
  return { ok: false, reason: "The document data is not a valid bill." };
}

export async function fetchPdf(
  client: PaperlessClient,
  doc: Pick<PaperlessDoc, "id" | "mime_type" | "archived_file_name">,
): Promise<Uint8Array | null> {
  const mime = (doc.mime_type ?? "").toLowerCase();
  if (mime === "application/pdf") {
    return client.download(`documents/${doc.id}/download`, {
      original: "true",
    });
  }
  // Images are served as their OCR'd PDF when Paperless made an archive version.
  if (doc.archived_file_name) {
    return client.download(`documents/${doc.id}/download`);
  }
  return null;
}

const RUN_LEVEL_ERRORS = new Set([
  "unauthorized",
  "network",
  "tls",
  "redirect",
  "version",
]);

const DOCUMENT_REASONS: Partial<
  Record<string, { status: "skipped" | "failed"; message: string }>
> = {
  not_found: {
    status: "skipped",
    message: "The document is no longer available in Paperless.",
  },
  too_large: { status: "skipped", message: "The file is larger than 25 MB." },
  wrong_type: { status: "skipped", message: "The file is not a PDF." },
  forbidden: {
    status: "failed",
    message: "Paperless did not allow reading this document.",
  },
  bad_request: {
    status: "failed",
    message: "Paperless rejected the request for this document.",
  },
  invalid_response: {
    status: "failed",
    message: "Paperless sent an unreadable response for this document.",
  },
};

interface RunState {
  /** Documents whose downloads failed in a row to connect or timed out. */
  networkStreak: PaperlessDoc["id"][];
}

const GAVE_UP_MESSAGE =
  "Paperless repeatedly failed to serve this document; it is retried when the document changes.";

/** Counts a failed attempt; true once the document has used up its attempts or its time. */
function recordAttempt(row: ConnectionRow, paperlessId: number): boolean {
  const now = new Date();
  const saved = getDB()
    .insert(paperlessPending)
    .values({
      userId: row.userId,
      connectionId: row.id,
      paperlessId,
      attempts: 1,
      firstFailedAt: now,
    })
    .onConflictDoUpdate({
      target: [paperlessPending.connectionId, paperlessPending.paperlessId],
      set: { attempts: sql`${paperlessPending.attempts} + 1` },
    })
    .returning()
    .get();
  return (
    saved.attempts >= MAX_DOCUMENT_ATTEMPTS ||
    now.getTime() - saved.firstFailedAt.getTime() >= MAX_DOCUMENT_RETRY_MS
  );
}

function clearAttempts(row: ConnectionRow, paperlessId: number): void {
  getDB()
    .delete(paperlessPending)
    .where(
      and(
        eq(paperlessPending.userId, row.userId),
        eq(paperlessPending.connectionId, row.id),
        eq(paperlessPending.paperlessId, paperlessId),
      ),
    )
    .run();
}

async function handle(
  userId: string,
  row: ConnectionRow,
  client: PaperlessClient,
  doc: PaperlessDoc,
  result: SyncResult,
  state: RunState,
): Promise<void> {
  result.listed++;
  let outcome: Outcome;
  try {
    outcome = await processDocument(userId, row, client, doc);
    if (outcome !== "unchanged") state.networkStreak = [];
    clearAttempts(row, doc.id);
  } catch (err) {
    // Only problems with the connection itself stop the run; a document Paperless
    // cannot serve is recorded and the run continues with the next one. The list
    // request already succeeded, so a single download that times out or fails to
    // connect belongs to its document; only a streak of them means the connection is down.
    if (err instanceof PaperlessError && err.code === "network") {
      state.networkStreak.push(doc.id);
      if (state.networkStreak.length >= NETWORK_STREAK_LIMIT) {
        // The connection is down, so the earlier documents in the streak were
        // not at fault: their attempts must not count toward the cap.
        for (const id of state.networkStreak) clearAttempts(row, id);
        throw err;
      }
    } else {
      state.networkStreak = [];
      if (err instanceof PaperlessError && RUN_LEVEL_ERRORS.has(err.code)) {
        throw err;
      }
    }
    if (isTransientError(err)) {
      if (!recordAttempt(row, doc.id)) {
        // No link is saved: the document stays pending and the watermark holds
        // (see sync), so the next run tries it again.
        console.warn("paperless document will be retried", errorCode(err));
        result.pending++;
        return;
      }
      // Out of attempts: fail it like any other document Paperless cannot serve,
      // which also lets the watermark move on.
      console.error("paperless document gave up", errorCode(err));
      clearAttempts(row, doc.id);
      saveLink(row, doc.id, {
        modified: parseModified(doc),
        status: "failed",
        error: GAVE_UP_MESSAGE,
      });
      result.failed++;
      return;
    }
    clearAttempts(row, doc.id);
    const reason =
      err instanceof PaperlessError ? DOCUMENT_REASONS[err.code] : undefined;
    if (reason === undefined) {
      console.error("paperless document failed", errorCode(err));
    }
    const skip = reason?.status === "skipped";
    saveLink(row, doc.id, {
      modified: parseModified(doc),
      status: skip ? "skipped" : "failed",
      error: reason?.message ?? "The document could not be processed.",
    });
    outcome = skip ? "skipped" : "failed";
  }
  if (outcome === "imported") result.imported++;
  else if (outcome === "updated") result.updated++;
  else if (outcome === "unchanged") result.unchanged++;
  else if (outcome === "skipped") result.skipped++;
  else result.failed++;
}

async function processDocument(
  userId: string,
  row: ConnectionRow,
  client: PaperlessClient,
  doc: PaperlessDoc,
): Promise<Outcome> {
  const modified = parseModified(doc);
  const link = findLink(row, doc.id);
  if (link && link.modified >= modified) return "unchanged";
  if (link?.lastPushedHash?.startsWith("ro:")) {
    // The document changed in Paperless: its permissions may have too.
    getDB()
      .update(paperlessDocuments)
      .set({ lastPushedHash: null })
      .where(
        and(
          eq(paperlessDocuments.userId, userId),
          eq(paperlessDocuments.id, link.id),
        ),
      )
      .run();
  }
  // The user deleted the bill that came from this document: do not bring it back for metadata changes.
  if (link && link.status === "imported" && link.billId === null) {
    touchModified(link, userId, modified);
    return "unchanged";
  }

  const ref = rowExternalRef(row, doc.id);
  if (!link && isDismissed(userId, ref)) {
    saveLink(row, doc.id, { modified, status: "imported", billId: null });
    return "unchanged";
  }
  if (!link) {
    const existing = findBillByRef(userId, ref);
    if (existing) {
      // Seen before (e.g. after reconnecting): link it instead of importing a duplicate.
      saveLink(row, doc.id, {
        modified,
        status: "imported",
        billId: existing.id,
        documentId: existing.documentId,
      });
      return "unchanged";
    }
  }

  const bytes = await fetchPdf(client, doc);
  if (bytes === null || !hasPdfMagic(bytes)) {
    saveLink(row, doc.id, {
      modified,
      status: "skipped",
      error: "The document is not a PDF.",
    });
    return "skipped";
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (link && link.status === "imported" && link.contentSha256 === sha) {
    touchModified(link, userId, modified);
    return "unchanged";
  }

  const fileName = doc.original_file_name ?? `paperless-${doc.id}.pdf`;
  const stored = storeDocument(
    userId,
    bytes,
    fileName,
    "application/pdf",
    "integration",
  );

  // The file of an already imported document changed: swap the stored file, keep the bill.
  if (link && link.status === "imported" && link.billId !== null) {
    const bill = getBill(userId, link.billId);
    const previous = bill.documentId;
    attachDocument(userId, bill.id, stored.id);
    saveLink(row, doc.id, {
      modified,
      status: "imported",
      billId: bill.id,
      documentId: stored.id,
      contentSha256: sha,
    });
    if (previous !== null && previous !== stored.id) {
      releaseDocument(userId, previous);
    }
    return "updated";
  }

  let extraction: BillExtraction;
  try {
    extraction = await extractBillFromPdf(bytes);
  } catch (err) {
    if (!(err instanceof PdfExtractError)) throw err;
    releaseDocument(userId, stored.id);
    saveLink(row, doc.id, {
      modified,
      status: "failed",
      error: pdfErrorMessage(err.code),
      contentSha256: sha,
    });
    return "failed";
  }

  const { draft, warnings } = billFromExtraction(extraction);
  const built = buildBillInput({ ...draft });
  if (!built.ok) {
    releaseDocument(userId, stored.id);
    saveLink(row, doc.id, {
      modified,
      status: "failed",
      error: built.reason,
      contentSha256: sha,
    });
    return "failed";
  }

  const bill = createBill(userId, built.input, {
    documentId: stored.id,
    extraction: { source: extraction.source, warnings },
    external: {
      externalSource: EXTERNAL_SOURCE,
      externalRef: ref,
      externalUrl: client.documentUrl(doc.id),
    },
  });
  saveLink(row, doc.id, {
    modified,
    status: "imported",
    billId: bill.id,
    documentId: stored.id,
    contentSha256: sha,
  });
  // The link row did not exist yet when the bill-created event fired.
  await pushBillSafely(userId, bill.id);
  return "imported";
}
