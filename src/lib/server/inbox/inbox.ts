import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "$lib/import-constants";
import { maskIban, normalizeIban } from "$lib/iban";
import {
  accounts,
  getDB,
  imports,
  inboxFiles,
  users,
  type InboxStatus as FileStatus,
} from "$lib/server/db";
import { parseCamt053 } from "$lib/server/importers/camt053";
import { ImportFormatError } from "$lib/server/importers/types";
import {
  MAPPING_REQUIRED,
  balanceWarningText,
  buildPreview,
  confirmImport,
  deletePending,
  detectFormat,
  startUpload,
} from "$lib/server/imports";
import { listAccounts, type AccountView } from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { describeError } from "$lib/server/errors";

export const DEFAULT_INTERVAL_SECONDS = 60;
export const DEFAULT_SETTLE_MS = 10_000;

const RESERVED = new Set(["processed", "failed", "review"]);
const EXTENSIONS = new Set([".xml", ".csv", ".txt", ".xlsx"]);

const configSchema = z.object({
  KEPT_INBOX_DIR: z.string().trim().min(1).optional(),
  KEPT_INBOX_INTERVAL: z.coerce
    .number()
    .int()
    .min(5)
    .max(86_400)
    .default(DEFAULT_INTERVAL_SECONDS),
});

export interface InboxConfig {
  dir: string;
  intervalSeconds: number;
}

/** The watch folder is off unless `KEPT_INBOX_DIR` is set. Invalid values throw. */
export function readInboxConfig(
  env: Record<string, string | undefined> = process.env,
): InboxConfig | null {
  const parsed = configSchema.safeParse({
    KEPT_INBOX_DIR: env.KEPT_INBOX_DIR || undefined,
    KEPT_INBOX_INTERVAL: env.KEPT_INBOX_INTERVAL || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid inbox configuration (${problems})`);
  }
  if (!parsed.data.KEPT_INBOX_DIR) return null;
  return {
    dir: parsed.data.KEPT_INBOX_DIR,
    intervalSeconds: parsed.data.KEPT_INBOX_INTERVAL,
  };
}

/** A user's folder, or null when the username is not a safe single path segment. */
export function userInboxDir(
  config: InboxConfig,
  username: string,
): string | null {
  if (
    username === "" ||
    username === "." ||
    username === ".." ||
    basename(username) !== username ||
    username.includes("\\")
  ) {
    return null;
  }
  return join(config.dir, username);
}

export interface ScanOptions {
  now?: number;
  /** A file modified less than this long ago is assumed to be still written. */
  settleMs?: number;
}

export interface ScanSummary {
  at: number;
  imported: number;
  review: number;
  failed: number;
  duplicate: number;
  skipped: number;
}

type Outcome = Exclude<keyof ScanSummary, "at">;

/** A file that cannot be imported, with a reason that is safe to show. */
class Rejected extends Error {}

interface Candidate {
  path: string;
  name: string;
  /** Account chosen by the subfolder the file was found in. */
  account: AccountView | null;
  /** Set when the subfolder matches no (or several) accounts. */
  problem: string | null;
}

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");

function moveInto(
  userDir: string,
  folder: "processed" | "failed" | "review",
  from: string,
  name: string,
  sha: string,
  now: number,
): string {
  const dir = join(userDir, folder);
  mkdirSync(dir, { recursive: true });
  const target = `${stamp(now)}-${sha.slice(0, 8)}-${name}`;
  renameSync(from, join(dir, target));
  return target;
}

function matchAccount(list: AccountView[], folder: string): AccountView {
  const wanted = folder.trim().toLowerCase();
  const wantedIban = normalizeIban(folder);
  const matches = list.filter(
    (a) =>
      a.name.trim().toLowerCase() === wanted ||
      (a.iban !== null && normalizeIban(a.iban) === wantedIban),
  );
  if (matches.length === 1) return matches[0]!;
  throw new Rejected(
    matches.length === 0
      ? `No account matches the folder name "${folder}". Name the folder after an account or its IBAN.`
      : `The folder name "${folder}" matches more than one account.`,
  );
}

function accountForCamt(bytes: Uint8Array, list: AccountView[]): AccountView {
  const statements = parseCamt053(new TextDecoder("utf-8").decode(bytes));
  const byIban = new Map<string, AccountView>();
  for (const a of list) if (a.iban) byIban.set(normalizeIban(a.iban), a);
  const matched = new Map<string, AccountView>();
  for (const s of statements) {
    const account = s.accountIban
      ? byIban.get(normalizeIban(s.accountIban))
      : null;
    if (account) matched.set(account.id, account);
  }
  if (matched.size === 1) return [...matched.values()][0]!;
  if (matched.size > 1) {
    throw new Rejected(
      "The file contains statements for several of your accounts. Put one account per file.",
    );
  }
  const ibans = [...new Set(statements.map((s) => s.accountIban))]
    .map((i) => (i ? maskIban(i) : "unknown"))
    .join(", ");
  throw new Rejected(
    `No account of yours has the statement's IBAN (${ibans}). Add the IBAN to the account or put the file in the account's folder.`,
  );
}

function listCandidates(userDir: string, list: AccountView[]): Candidate[] {
  const out: Candidate[] = [];
  const scan = (
    dir: string,
    account: AccountView | null,
    problem: string | null,
  ) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (!EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      out.push({
        path: join(dir, entry.name),
        name: entry.name,
        account,
        problem,
      });
    }
  };
  scan(userDir, null, null);
  for (const entry of readdirSync(userDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (RESERVED.has(entry.name)) continue;
    let account: AccountView | null = null;
    let problem: string | null = null;
    try {
      account = matchAccount(list, entry.name);
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      problem = err.message;
    }
    scan(join(userDir, entry.name), account, problem);
  }
  return out;
}

function saveEntry(
  userId: string,
  name: string,
  sha: string,
  values: Partial<typeof inboxFiles.$inferInsert> & { status: FileStatus },
) {
  const set = {
    fileName: name,
    reason: null,
    accountId: null,
    importId: null,
    newCount: null,
    duplicateCount: null,
    reviewFile: null,
    ...values,
  };
  getDB()
    .insert(inboxFiles)
    .values({ userId, sha256: sha, ...set })
    .onConflictDoUpdate({
      target: [inboxFiles.userId, inboxFiles.sha256],
      set,
    })
    .run();
}

interface ScanContext {
  userId: string;
  userDir: string;
  accounts: AccountView[];
  now: number;
  settleMs: number;
}

/** Removes the pending upload; confirmImport has already removed it on success. */
async function dropPending(userId: string, pendingId: string) {
  try {
    await deletePending(userId, pendingId);
  } catch (err) {
    // The row is gone either way; a leftover blob is reclaimed by the orphan sweep.
    if (!(err instanceof LedgerError && err.code === "not_found")) {
      console.error("inbox pending cleanup failed", describeError(err));
    }
  }
}

async function importCandidate(
  ctx: ScanContext,
  c: Candidate,
  bytes: Uint8Array,
  sha: string,
): Promise<Outcome> {
  const { userId, userDir, now } = ctx;
  if (c.problem) throw new Rejected(c.problem);
  const format = detectFormat(bytes);
  let account = c.account;
  if (!account) {
    if (format !== "camt053") {
      throw new Rejected(
        "Cannot tell which account this file belongs to. Put CSV and Excel files in a folder named after the account.",
      );
    }
    account = accountForCamt(bytes, ctx.accounts);
  }

  const { meta } = await startUpload(
    userId,
    account.id,
    new File([new Uint8Array(bytes)], c.name),
  );
  try {
    const preview = await buildPreview(userId, meta.id);
    const review = (reason: string): Outcome => {
      const reviewFile = moveInto(userDir, "review", c.path, c.name, sha, now);
      saveEntry(userId, c.name, sha, {
        status: "review",
        reason,
        accountId: account.id,
        reviewFile,
      });
      return "review";
    };
    if (preview.errors.length === 1 && preview.errors[0] === MAPPING_REQUIRED) {
      return review(
        "No column mapping is saved for this account yet. Review the file to map its columns.",
      );
    }
    if (preview.errors.length > 0) throw new Rejected(preview.errors.join(" "));
    if (preview.alreadyImportedAt !== null) {
      moveInto(userDir, "processed", c.path, c.name, sha, now);
      saveEntry(userId, c.name, sha, {
        status: "duplicate",
        reason: "This exact file was already imported into the account.",
        accountId: account.id,
      });
      return "duplicate";
    }
    const warnings = [
      ...preview.warnings,
      ...preview.balanceWarnings.map(balanceWarningText),
    ];
    if (warnings.length > 0) return review(warnings.join(" "));

    const result = await confirmImport(userId, meta.id);
    moveInto(userDir, "processed", c.path, c.name, sha, now);
    saveEntry(userId, c.name, sha, {
      status: "imported",
      accountId: account.id,
      importId: result.importId,
      newCount: result.newCount,
      duplicateCount: result.duplicateCount,
    });
    return "imported";
  } finally {
    await dropPending(userId, meta.id);
  }
}

async function processFile(ctx: ScanContext, c: Candidate): Promise<Outcome> {
  const before = statSync(c.path);
  if (ctx.now - before.mtimeMs < ctx.settleMs || before.size === 0) {
    return "skipped";
  }
  if (before.size > MAX_UPLOAD_BYTES) {
    // Hashing a huge file is pointless; identify it by name and size.
    const sha = createHash("sha256")
      .update(`${c.name}:${before.size}`)
      .digest("hex");
    return fail(
      ctx,
      c,
      sha,
      `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  const bytes = new Uint8Array(readFileSync(c.path));
  const after = statSync(c.path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    return "skipped";
  }
  const sha = createHash("sha256").update(bytes).digest("hex");

  const known = getDB()
    .select({ status: inboxFiles.status })
    .from(inboxFiles)
    .where(and(eq(inboxFiles.userId, ctx.userId), eq(inboxFiles.sha256, sha)))
    .get();
  if (known && known.status !== "failed") {
    moveInto(ctx.userDir, "processed", c.path, c.name, sha, ctx.now);
    return "duplicate";
  }

  try {
    return await importCandidate(ctx, c, bytes, sha);
  } catch (err) {
    if (
      err instanceof Rejected ||
      err instanceof LedgerError ||
      err instanceof ImportFormatError
    ) {
      return fail(ctx, c, sha, err.message);
    }
    console.error(
      "inbox: unexpected error while importing a file: %s",
      describeError(err),
    );
    return fail(
      ctx,
      c,
      sha,
      "Unexpected error while importing; see the server log.",
    );
  }
}

function fail(
  ctx: ScanContext,
  c: Candidate,
  sha: string,
  reason: string,
): Outcome {
  saveEntry(ctx.userId, c.name, sha, {
    status: "failed",
    reason,
    accountId: c.account?.id ?? null,
  });
  const moved = moveInto(ctx.userDir, "failed", c.path, c.name, sha, ctx.now);
  writeFileSync(
    join(ctx.userDir, "failed", `${moved}.reason.txt`),
    `${reason}\n`,
  );
  return "failed";
}

/** Files that waited for review and have since been imported move to processed/. */
function reconcileReviews(userId: string, userDir: string) {
  const db = getDB();
  const rows = db
    .select()
    .from(inboxFiles)
    .where(and(eq(inboxFiles.userId, userId), eq(inboxFiles.status, "review")))
    .all();
  for (const row of rows) {
    const imported = db
      .select({ id: imports.id })
      .from(imports)
      .where(
        and(eq(imports.userId, userId), eq(imports.fileSha256, row.sha256)),
      )
      .get();
    if (!imported) continue;
    if (row.reviewFile) {
      const from = join(userDir, "review", row.reviewFile);
      if (existsSync(from)) {
        mkdirSync(join(userDir, "processed"), { recursive: true });
        renameSync(from, join(userDir, "processed", row.reviewFile));
      }
    }
    db.update(inboxFiles)
      .set({
        status: "imported",
        importId: imported.id,
        reason: null,
        reviewFile: null,
      })
      .where(eq(inboxFiles.id, row.id))
      .run();
  }
}

/** Scans every user's inbox folder once. Never throws for a single bad file or user. */
export async function scanInbox(
  config: InboxConfig,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const now = options.now ?? Date.now();
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const summary: ScanSummary = {
    at: now,
    imported: 0,
    review: 0,
    failed: 0,
    duplicate: 0,
    skipped: 0,
  };
  const all = getDB()
    .select({ id: users.id, username: users.username })
    .from(users)
    .all();
  for (const user of all) {
    const userDir = userInboxDir(config, user.username);
    if (userDir === null) continue;
    try {
      mkdirSync(userDir, { recursive: true });
      reconcileReviews(user.id, userDir);
      const ctx: ScanContext = {
        userId: user.id,
        userDir,
        accounts: (await listAccounts(user.id)).filter((a) => !a.archived),
        now,
        settleMs,
      };
      for (const c of listCandidates(userDir, ctx.accounts)) {
        try {
          summary[await processFile(ctx, c)]++;
        } catch (err) {
          console.error(
            "inbox: could not handle a file: %s",
            describeError(err),
          );
        }
      }
    } catch (err) {
      console.error(
        "inbox: could not scan a user folder: %s",
        describeError(err),
      );
    }
  }
  return summary;
}

export interface InboxEntry {
  id: string;
  fileName: string;
  status: FileStatus;
  reason: string | null;
  accountName: string | null;
  newCount: number | null;
  duplicateCount: number | null;
  updatedAt: number;
}

export function listInboxEntries(userId: string, limit = 10): InboxEntry[] {
  return getDB()
    .select({
      id: inboxFiles.id,
      fileName: inboxFiles.fileName,
      status: inboxFiles.status,
      reason: inboxFiles.reason,
      accountName: accounts.name,
      newCount: inboxFiles.newCount,
      duplicateCount: inboxFiles.duplicateCount,
      updatedAt: inboxFiles.updatedAt,
    })
    .from(inboxFiles)
    .leftJoin(accounts, eq(accounts.id, inboxFiles.accountId))
    .where(eq(inboxFiles.userId, userId))
    .orderBy(desc(inboxFiles.updatedAt))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, updatedAt: r.updatedAt.getTime() }));
}

/**
 * Turns a file waiting in review/ into a regular pending upload and returns
 * where the user continues (preview, or the mapping page without a profile).
 */
export async function startInboxReview(
  config: InboxConfig,
  user: { id: string; username: string },
  entryId: string,
): Promise<string> {
  const row = getDB()
    .select()
    .from(inboxFiles)
    .where(and(eq(inboxFiles.userId, user.id), eq(inboxFiles.id, entryId)))
    .get();
  const userDir = userInboxDir(config, user.username);
  if (
    !row ||
    row.status !== "review" ||
    !row.reviewFile ||
    !row.accountId ||
    userDir === null
  ) {
    throw new LedgerError(
      "not_found",
      "This file is no longer waiting for review.",
    );
  }
  const path = join(userDir, "review", basename(row.reviewFile));
  if (!existsSync(path)) {
    throw new LedgerError(
      "not_found",
      "The file is no longer in the review folder.",
    );
  }
  const bytes = new Uint8Array(readFileSync(path));
  const { meta, needsMapping } = await startUpload(
    user.id,
    row.accountId,
    new File([bytes], row.fileName),
  );
  return needsMapping ? `/import/${meta.id}/mapping` : `/import/${meta.id}`;
}

let lastScan: ScanSummary | null = null;
export const getLastScan = () => lastScan;
export const setLastScan = (s: ScanSummary | null) => {
  lastScan = s;
};

export interface InboxView {
  enabled: boolean;
  folder: string | null;
  lastScan: ScanSummary | null;
  entries: InboxEntry[];
}

export function getInboxView(
  userId: string,
  username: string,
  config: InboxConfig | null = readInboxConfig(),
): InboxView {
  return {
    enabled: config !== null,
    folder: config ? userInboxDir(config, username) : null,
    lastScan,
    entries: config ? listInboxEntries(userId) : [],
  };
}

/** Scans on start (after a short delay) and then every `intervalSeconds`. Returns a stop function. */
export function startInboxScheduler(
  config: InboxConfig,
  options: { intervalMs?: number; firstRunDelayMs?: number } & ScanOptions = {},
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      setLastScan(await scanInbox(config, options));
    } catch (err) {
      console.error("inbox scan failed: %s", describeError(err));
    } finally {
      running = false;
    }
  };
  // tick() handles its own errors, so nothing is left to await or catch here.
  const first = setTimeout(() => void tick(), options.firstRunDelayMs ?? 5_000);
  const timer = setInterval(
    () => void tick(),
    options.intervalMs ?? config.intervalSeconds * 1000,
  );
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
