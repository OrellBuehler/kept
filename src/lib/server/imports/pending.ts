import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { IMPORT_FORMATS } from "$lib/ledger-types";
import { LedgerError, notFound } from "$lib/server/ledger/errors";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const pendingIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const userIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const metaSchema = z.object({
  id: pendingIdSchema,
  userId: userIdSchema,
  accountId: z.string().min(1),
  fileName: z.string(),
  format: z.enum(IMPORT_FORMATS),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int(),
});
export type PendingMeta = z.infer<typeof metaSchema>;

export function pendingRoot(): string {
  const dbPath = process.env.DATABASE_PATH ?? "./data/kept.db";
  // An in-memory database has no directory to live next to.
  if (dbPath === ":memory:") return join(tmpdir(), "kept", "pending-imports");
  return join(dirname(dbPath), "pending-imports");
}

/** Validates before any filesystem access: an invalid id is simply "not found". */
function paths(userId: string, pendingId: string) {
  const id = pendingIdSchema.safeParse(pendingId);
  const user = userIdSchema.safeParse(userId);
  if (!id.success || !user.success) throw notFound("Upload");
  const dir = join(pendingRoot(), user.data);
  return {
    dir,
    data: join(dir, id.data),
    sidecar: join(dir, `${id.data}.json`),
  };
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function readMeta(sidecar: string): PendingMeta | null {
  let text: string;
  try {
    text = readFileSync(sidecar, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = metaSchema.safeParse(safeJson(text));
  return parsed.success ? parsed.data : null;
}

/** Removes every expired upload (and orphaned data files) of all users. */
export function purgeExpired(now = Date.now()): void {
  const root = pendingRoot();
  if (!existsSync(root)) return;
  for (const user of readdirSync(root)) {
    const dir = join(root, user);
    if (!statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry);
      if (entry.endsWith(".json")) {
        const meta = readMeta(file);
        if (meta === null || now - meta.createdAt > PENDING_TTL_MS) {
          rmSync(file, { force: true });
          rmSync(file.slice(0, -".json".length), { force: true });
        }
      } else if (
        existsSync(file) &&
        !existsSync(`${file}.json`) &&
        now - statSync(file).mtimeMs > PENDING_TTL_MS
      ) {
        rmSync(file, { force: true });
      }
    }
  }
}

export function storePending(
  userId: string,
  input: { accountId: string; fileName: string; bytes: Uint8Array },
): PendingMeta {
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new LedgerError(
      "invalid",
      `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      "file",
    );
  }
  const format = detectFormat(input.bytes);
  purgeExpired();
  const id = randomBytes(24).toString("base64url");
  const meta: PendingMeta = {
    id,
    userId,
    accountId: input.accountId,
    fileName: cleanFileName(input.fileName),
    format,
    size: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    createdAt: Date.now(),
  };
  const { dir, data, sidecar } = paths(userId, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(data, input.bytes, { mode: 0o600 });
  writeFileSync(sidecar, JSON.stringify(meta), { mode: 0o600 });
  return meta;
}

/** Metadata of a pending upload; not found when missing, expired or not owned. */
export function getPendingMeta(
  userId: string,
  pendingId: string,
  now = Date.now(),
): PendingMeta {
  const { sidecar, data } = paths(userId, pendingId);
  const meta = readMeta(sidecar);
  if (meta === null || meta.userId !== userId || meta.id !== pendingId) {
    throw notFound("Upload");
  }
  if (now - meta.createdAt > PENDING_TTL_MS) {
    rmSync(sidecar, { force: true });
    rmSync(data, { force: true });
    throw notFound("Upload");
  }
  return meta;
}

export function readPending(
  userId: string,
  pendingId: string,
): { meta: PendingMeta; bytes: Uint8Array } {
  const meta = getPendingMeta(userId, pendingId);
  const { data } = paths(userId, pendingId);
  try {
    return { meta, bytes: new Uint8Array(readFileSync(data)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw notFound("Upload");
    }
    throw err;
  }
}

/** Removes the upload; not found when it does not exist for this user. */
export function deletePending(userId: string, pendingId: string): void {
  getPendingMeta(userId, pendingId);
  const { data, sidecar } = paths(userId, pendingId);
  rmSync(sidecar, { force: true });
  rmSync(data, { force: true });
}
