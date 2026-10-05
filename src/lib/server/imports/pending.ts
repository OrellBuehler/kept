import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { IMPORT_FORMATS } from "$lib/ledger-types";
import { MAX_UPLOAD_BYTES } from "$lib/import-constants";
import { first, getDB, pendingImports, type DB } from "$lib/server/db";
import { describeError } from "$lib/server/errors";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { getStore } from "$lib/server/storage";

export { MAX_UPLOAD_BYTES };
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const BLOB_PREFIX = "pending-imports/";

const pendingIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

export interface PendingMeta {
  id: string;
  userId: string;
  accountId: string;
  fileName: string;
  format: (typeof IMPORT_FORMATS)[number];
  size: number;
  sha256: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; the upload is gone after this instant. */
  expiresAt: number;
}

const columns = {
  id: pendingImports.id,
  userId: pendingImports.userId,
  accountId: pendingImports.accountId,
  fileName: pendingImports.fileName,
  format: pendingImports.format,
  size: pendingImports.size,
  sha256: pendingImports.sha256,
  createdAt: pendingImports.createdAt,
  expiresAt: pendingImports.expiresAt,
};

function toMeta(row: {
  id: string;
  userId: string;
  accountId: string;
  fileName: string;
  format: PendingMeta["format"];
  size: number;
  sha256: string;
  createdAt: Date;
  expiresAt: Date;
}): PendingMeta {
  return {
    ...row,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export function pendingBlobKey(userId: string, pendingId: string): string {
  return `${BLOB_PREFIX}${userId}/${pendingId}`;
}

/** A malformed id can never exist, so it is simply "not found" without a query. */
function checkId(pendingId: string): string {
  const id = pendingIdSchema.safeParse(pendingId);
  if (!id.success) throw notFound("Upload");
  return id.data;
}

function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 200) || "upload";
}

/**
 * Detects the format from the content, never from the extension. Only
 * camt.053 XML, xlsx (zip) and text (csv) are accepted.
 */
export function detectFormat(
  bytes: Uint8Array,
): (typeof IMPORT_FORMATS)[number] {
  if (bytes.length === 0) {
    throw new LedgerError("invalid", "The file is empty.", "file");
  }
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "xlsx";
  }
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (!utf16) {
    const head = new TextDecoder("utf-8")
      .decode(bytes.subarray(0, 4096))
      .trimStart();
    if (head.startsWith("<")) {
      if (/camt\.053/i.test(head)) return "camt053";
      throw new LedgerError(
        "invalid",
        "This XML file is not a camt.053 account statement (other message types such as camt.054 or pain are not supported).",
        "file",
      );
    }
  }
  return "csv";
}

/**
 * Removes every expired upload (row and blob) of all users. A blob that cannot be
 * removed keeps its row, so the next purge retries it.
 */
export async function purgeExpired(now = Date.now()): Promise<void> {
  const db = getDB();
  const expired = await db
    .select({ id: pendingImports.id, userId: pendingImports.userId })
    .from(pendingImports)
    .where(lt(pendingImports.expiresAt, new Date(now)));
  const store = getStore();
  for (const { id, userId } of expired) {
    try {
      await store.delete(pendingBlobKey(userId, id));
    } catch (err) {
      console.error(
        "could not delete expired pending import %s: %s",
        id,
        describeError(err),
      );
      continue;
    }
    await db.delete(pendingImports).where(eq(pendingImports.id, id));
  }
}

/**
 * Removes blobs below `pending-imports/` that no row owns: leftovers of deleted
 * users or accounts, failed uploads, and files of the old sidecar layout
 * (`<id>` plus `<id>.json`). A blob younger than the TTL is never touched, as
 * its row may not be written yet.
 */
export async function sweepOrphanedPending(now = Date.now()): Promise<number> {
  const db = getDB();
  const store = getStore();
  const orphans: string[] = [];
  for await (const blob of store.list(BLOB_PREFIX)) {
    if (now - blob.modifiedAt <= PENDING_TTL_MS) continue;
    const [userId, id, ...rest] = blob.key.slice(BLOB_PREFIX.length).split("/");
    const owned =
      userId !== undefined &&
      id !== undefined &&
      rest.length === 0 &&
      pendingIdSchema.safeParse(id).success &&
      (await first(
        db
          .select({ id: pendingImports.id })
          .from(pendingImports)
          .where(
            and(eq(pendingImports.id, id), eq(pendingImports.userId, userId)),
          )
          .limit(1),
      )) !== undefined;
    if (!owned) orphans.push(blob.key);
  }
  let removed = 0;
  for (const key of orphans) {
    try {
      await store.delete(key);
      removed++;
    } catch (err) {
      console.error("pending import orphan delete failed", describeError(err));
    }
  }
  return removed;
}

const ORPHAN_SWEEP_INTERVAL_MS = PENDING_TTL_MS;
let lastOrphanSweep = 0;

async function maintain(now: number): Promise<void> {
  await purgeExpired(now);
  if (now - lastOrphanSweep >= ORPHAN_SWEEP_INTERVAL_MS) {
    lastOrphanSweep = now;
    await sweepOrphanedPending(now);
  }
}

/** Housekeeping at startup; failures are logged and retried by the next upload. */
export function startPendingSweep(): void {
  maintain(Date.now()).catch((err) => {
    lastOrphanSweep = 0;
    console.error("pending import cleanup failed: %s", describeError(err));
  });
}

export async function storePending(
  userId: string,
  input: { accountId: string; fileName: string; bytes: Uint8Array },
): Promise<PendingMeta> {
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new LedgerError(
      "invalid",
      `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      "file",
    );
  }
  const format = detectFormat(input.bytes);
  const now = Date.now();
  try {
    await maintain(now);
  } catch (err) {
    // Housekeeping must not fail an upload; expired rows are retried next time.
    lastOrphanSweep = 0;
    console.error("pending import cleanup failed: %s", describeError(err));
  }
  const id = randomBytes(24).toString("base64url");
  const key = pendingBlobKey(userId, id);
  const store = getStore();
  await store.put(key, input.bytes);
  try {
    const [row] = await getDB()
      .insert(pendingImports)
      .values({
        id,
        userId,
        accountId: input.accountId,
        fileName: cleanFileName(input.fileName),
        format,
        size: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        createdAt: new Date(now),
        expiresAt: new Date(now + PENDING_TTL_MS),
      })
      .returning(columns);
    return toMeta(row!);
  } catch (err) {
    await store.delete(key);
    throw err;
  }
}

/** Metadata of a pending upload; not found when missing, expired or not owned. */
export async function getPendingMeta(
  userId: string,
  pendingId: string,
  now = Date.now(),
): Promise<PendingMeta> {
  const id = checkId(pendingId);
  const row = await first(
    getDB()
      .select(columns)
      .from(pendingImports)
      .where(and(eq(pendingImports.userId, userId), eq(pendingImports.id, id)))
      .limit(1),
  );
  if (!row || row.expiresAt.getTime() < now) throw notFound("Upload");
  return toMeta(row);
}

export async function readPending(
  userId: string,
  pendingId: string,
): Promise<{ meta: PendingMeta; bytes: Uint8Array }> {
  const meta = await getPendingMeta(userId, pendingId);
  const bytes = await getStore().get(pendingBlobKey(userId, meta.id));
  if (bytes === null) throw notFound("Upload");
  return { meta, bytes };
}

/**
 * Deletes the row only; false when this user has no such upload. Follow with
 * `deletePendingBlob`.
 */
export async function deletePendingRow(
  userId: string,
  pendingId: string,
): Promise<boolean> {
  const id = checkId(pendingId);
  const deleted = await getDB()
    .delete(pendingImports)
    .where(and(eq(pendingImports.userId, userId), eq(pendingImports.id, id)))
    .returning({ id: pendingImports.id });
  return deleted.length > 0;
}

/** Runs inside the transaction of confirmImport. */
export async function deletePendingRowInTx(
  tx: Pick<DB, "delete">,
  userId: string,
  pendingId: string,
): Promise<boolean> {
  const id = checkId(pendingId);
  return (
    (
      await tx
        .delete(pendingImports)
        .where(
          and(eq(pendingImports.userId, userId), eq(pendingImports.id, id)),
        )
        .returning({ id: pendingImports.id })
    ).length > 0
  );
}

export async function deletePendingBlob(
  userId: string,
  pendingId: string,
): Promise<void> {
  await getStore().delete(pendingBlobKey(userId, checkId(pendingId)));
}

/** Removes the upload; not found when it does not exist for this user. */
export async function deletePending(
  userId: string,
  pendingId: string,
): Promise<void> {
  if (!(await deletePendingRow(userId, pendingId))) throw notFound("Upload");
  await deletePendingBlob(userId, pendingId);
}
