import { createHash } from "node:crypto";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { DocumentSource } from "$lib/bill-types";
import { documents, first, getDB, isUniqueViolation } from "$lib/server/db";
import { detach } from "$lib/server/detached";
import { describeError } from "$lib/server/errors";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { runExclusive } from "$lib/server/scheduling";
import { getStore } from "$lib/server/storage";
import { MAX_PDF_BYTES } from "./pdf-extract";

export const MAX_DOCUMENT_BYTES = MAX_PDF_BYTES;
export const PDF_MIME = "application/pdf";

export interface DocumentMeta {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: DocumentSource;
  createdAt: number;
}

/** Blob key of a document; `storageKey` (`<userId>/<id>`) is what the documents table keeps. */
const BLOB_PREFIX = "documents/";

function blobKey(storageKey: string): string {
  return `${BLOB_PREFIX}${storageKey}`;
}

/** A blob younger than this is never swept: its row may not be written yet. */
export const DOCUMENT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ORPHAN_BATCH = 500;
const OWNER_LOOKUP_CHUNK = 200;
const MAX_CONSECUTIVE_DELETE_FAILURES = 20;
let lastOrphanSweep = 0;

/**
 * Removes blobs below `documents/` that no row owns: leftovers of deleted users,
 * failed deletes and failed uploads. Deletes at most `limit` blobs per run; the
 * rest follow on the next run. A failed delete is logged and retried later.
 */
export async function sweepOrphanedDocuments(
  now = Date.now(),
  limit = ORPHAN_BATCH,
): Promise<number> {
  const db = getDB();
  const store = getStore();
  const orphans: string[] = [];
  let chunk: string[] = [];
  const check = async () => {
    const batch = chunk;
    chunk = [];
    if (batch.length === 0) return;
    const owned = new Set(
      (
        await db
          .select({ storageKey: documents.storageKey })
          .from(documents)
          .where(
            inArray(
              documents.storageKey,
              batch.map((k) => k.slice(BLOB_PREFIX.length)),
            ),
          )
      ).map((r) => blobKey(r.storageKey)),
    );
    for (const key of batch) if (!owned.has(key)) orphans.push(key);
  };
  for await (const blob of store.list(BLOB_PREFIX)) {
    if (now - blob.modifiedAt <= DOCUMENT_ORPHAN_GRACE_MS) continue;
    chunk.push(blob.key);
    if (chunk.length >= OWNER_LOOKUP_CHUNK) await check();
    if (orphans.length >= limit) break;
  }
  await check();
  let removed = 0;
  let failures = 0;
  for (const key of orphans.slice(0, limit)) {
    try {
      await store.delete(key);
      removed++;
      failures = 0;
    } catch (err) {
      console.error("document orphan delete failed: %s", describeError(err));
      if (++failures >= MAX_CONSECUTIVE_DELETE_FAILURES) {
        console.error(
          "document orphan sweep stopped after %d consecutive delete failures",
          failures,
        );
        break;
      }
    }
  }
  return removed;
}

async function maintainDocuments(now: number): Promise<void> {
  if (now - lastOrphanSweep < ORPHAN_SWEEP_INTERVAL_MS) return;
  lastOrphanSweep = now;
  try {
    await runExclusive("document orphan sweep", async () => {
      await sweepOrphanedDocuments(now);
    });
  } catch (err) {
    // Housekeeping must not fail an upload; the next upload retries.
    lastOrphanSweep = 0;
    console.error("document orphan sweep failed: %s", describeError(err));
  }
}

/** Housekeeping at startup; detached, so shutdown drains it. Failures are logged and retried by the next upload. */
export function startDocumentSweep(): void {
  detach(maintainDocuments(Date.now()));
}

/**
 * Deletes every blob of a user, for use after the user (and with it the document
 * rows) is gone. Returns the number removed; a failing delete throws after the
 * remaining blobs were attempted.
 */
export async function deleteDocumentBlobsOf(userId: string): Promise<number> {
  const store = getStore();
  const keys: string[] = [];
  for await (const blob of store.list(`${BLOB_PREFIX}${userId}/`)) {
    keys.push(blob.key);
  }
  let removed = 0;
  let failure: unknown = null;
  for (const key of keys) {
    try {
      await store.delete(key);
      removed++;
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== null) throw failure;
  return removed;
}

const meta = {
  id: documents.id,
  fileName: documents.fileName,
  mimeType: documents.mimeType,
  size: documents.size,
  sha256: documents.sha256,
  source: documents.source,
  createdAt: documents.createdAt,
};

function toMeta(row: {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: DocumentSource;
  createdAt: Date;
}): DocumentMeta {
  return { ...row, createdAt: row.createdAt.getTime() };
}

export function sanitizeFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  const name = cleaned.slice(0, 200);
  return name === "" || name === "." || name === ".." ? "document.pdf" : name;
}

export function hasPdfMagic(bytes: Uint8Array): boolean {
  let i = 0;
  while (
    i < bytes.length &&
    i < 64 &&
    [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i]!)
  )
    i++;
  return new TextDecoder("latin1").decode(bytes.subarray(i, i + 5)) === "%PDF-";
}

/**
 * Stores a file for the user. Uploads must be PDFs (checked by content, the declared
 * type is ignored). Identical content (same sha256) is stored once per user.
 */
export async function storeDocument(
  userId: string,
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  source: DocumentSource = "upload",
): Promise<DocumentMeta> {
  if (bytes.byteLength === 0) {
    throw new LedgerError("invalid", "The file is empty.", "file");
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new LedgerError(
      "invalid",
      `The file is larger than ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`,
      "file",
    );
  }
  if (source === "upload" && !hasPdfMagic(bytes)) {
    throw new LedgerError("invalid", "The file is not a PDF.", "file");
  }

  detach(maintainDocuments(Date.now()));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const store = getStore();
  const storedType = source === "upload" ? PDF_MIME : mimeType;
  const existing = await findBySha256(userId, sha256);
  if (existing) {
    const key = blobKey(existing.storageKey);
    let restored = false;
    if (!(await store.has(key))) {
      await store.put(key, bytes, storedType);
      restored = true;
    }
    // A concurrent delete may have removed the row while we awaited the store.
    const stillThere = await findBySha256(userId, sha256);
    if (stillThere?.id === existing.id) return toMeta(existing);
    if (restored) await store.delete(key);
    if (stillThere) return toMeta(stillThere);
    // Gone: fall through and store it as a new document.
  }

  const id = crypto.randomUUID();
  const storageKey = `${userId}/${id}`;
  const key = blobKey(storageKey);
  await store.put(key, bytes, storedType);
  try {
    const [row] = await getDB()
      .insert(documents)
      .values({
        id,
        userId,
        fileName: sanitizeFileName(fileName),
        mimeType: storedType,
        size: bytes.byteLength,
        sha256,
        storageKey,
        source,
      })
      .returning(meta);
    return toMeta(row!);
  } catch (err) {
    try {
      await store.delete(key);
    } catch (cleanupErr) {
      // The sweep reclaims the blob; the insert error below is the one to report.
      console.error(
        "could not remove blob after failed insert: %s",
        describeError(cleanupErr),
      );
    }
    // A concurrent upload of the same content won the unique (user, sha256) index.
    if (isUniqueViolation(err)) {
      const winner = await findBySha256(userId, sha256);
      if (winner) return toMeta(winner);
    }
    throw err;
  }
}

function findBySha256(userId: string, sha256: string) {
  return first(
    getDB()
      .select({ ...meta, storageKey: documents.storageKey })
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.sha256, sha256)))
      .limit(1),
  );
}

export async function getDocumentMeta(
  userId: string,
  id: string,
): Promise<DocumentMeta> {
  const row = await first(
    getDB()
      .select(meta)
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Document");
  return toMeta(row);
}

export async function readDocument(
  userId: string,
  id: string,
): Promise<{ meta: DocumentMeta; bytes: Uint8Array }> {
  const row = await first(
    getDB()
      .select({ ...meta, storageKey: documents.storageKey })
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Document");
  const bytes = await getStore().get(blobKey(row.storageKey));
  if (bytes === null) throw notFound("Document file");
  return { meta: toMeta(row), bytes };
}

/** Removes the file and the row; bills that referenced it keep working without a document. */
export async function deleteDocument(
  userId: string,
  id: string,
): Promise<void> {
  if (!(await deleteDocumentWhere(userId, id))) throw notFound("Document");
}

/**
 * Deletes the row, then its file, only if `condition` still holds when the
 * delete runs. A reference check passed as `condition` is part of the same
 * statement, so a bill attached since the caller looked keeps its document.
 * False when there is no such document or the condition failed.
 */
export async function deleteDocumentWhere(
  userId: string,
  id: string,
  condition?: SQL,
): Promise<boolean> {
  const [deleted] = await getDB()
    .delete(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, id), condition))
    .returning({ storageKey: documents.storageKey });
  if (!deleted) return false;
  try {
    await getStore().delete(blobKey(deleted.storageKey));
  } catch (err) {
    // The row is gone, so the delete succeeded for the user; the sweep reclaims the blob.
    console.error("could not delete document blob: %s", describeError(err));
  }
  return true;
}
