import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { DocumentSource } from "$lib/bill-types";
import { documents, getDB } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
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

let rootOverride: string | null = null;

/** Tests only: store documents below this directory; pass null to reset. */
export function setDocumentsRoot(dir: string | null): void {
  rootOverride = dir;
}

/** `<dirname(DATABASE_PATH)>/documents`, next to the database file. */
export function documentsRoot(): string {
  if (rootOverride !== null) return resolve(rootOverride);
  const dbPath = process.env.DATABASE_PATH ?? "./data/kept.db";
  if (dbPath === ":memory:") {
    throw new Error("Documents need a file-backed DATABASE_PATH");
  }
  return resolve(dirname(dbPath), "documents");
}

function absolutePath(storageKey: string): string {
  const root = documentsRoot();
  const full = resolve(root, storageKey);
  if (!full.startsWith(root + sep)) {
    throw new Error("Document path escapes the documents directory");
  }
  return full;
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
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/**
 * Stores a file for the user. Uploads must be PDFs (checked by content, the declared
 * type is ignored). Identical content (same sha256) is stored once per user.
 */
export function storeDocument(
  userId: string,
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  source: DocumentSource = "upload",
): DocumentMeta {
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

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const db = getDB();
  const existing = db
    .select({ ...meta, storageKey: documents.storageKey })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.sha256, sha256)))
    .get();
  if (existing) {
    const path = absolutePath(existing.storageKey);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    return toMeta(existing);
  }

  const id = crypto.randomUUID();
  const storageKey = join(userId, id);
  const path = absolutePath(storageKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  try {
    const row = db
      .insert(documents)
      .values({
        id,
        userId,
        fileName: sanitizeFileName(fileName),
        mimeType: source === "upload" ? PDF_MIME : mimeType,
        size: bytes.byteLength,
        sha256,
        storageKey,
        source,
      })
      .returning(meta)
      .get();
    return toMeta(row);
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
}

export function getDocumentMeta(userId: string, id: string): DocumentMeta {
  const row = getDB()
    .select(meta)
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, id)))
    .get();
  if (!row) throw notFound("Document");
  return toMeta(row);
}

export function readDocument(
  userId: string,
  id: string,
): { meta: DocumentMeta; bytes: Uint8Array } {
  const row = getDB()
    .select({ ...meta, storageKey: documents.storageKey })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, id)))
    .get();
  if (!row) throw notFound("Document");
  const path = absolutePath(row.storageKey);
  if (!existsSync(path)) throw notFound("Document file");
  return { meta: toMeta(row), bytes: new Uint8Array(readFileSync(path)) };
}

/** Removes the file and the row; bills that referenced it keep working without a document. */
export function deleteDocument(userId: string, id: string): void {
  const row = getDB()
    .select({ storageKey: documents.storageKey })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, id)))
    .get();
  if (!row) throw notFound("Document");
  getDB()
    .delete(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, id)))
    .run();
  rmSync(absolutePath(row.storageKey), { force: true });
}
