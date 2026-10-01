import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { DB } from "$lib/server/db";

const FILE_PATTERN = /^kept-backup-(\d{8}-\d{6})\.db$/;

export const DEFAULT_KEEP = 7;

const configSchema = z.object({
  KEPT_BACKUP_DIR: z.string().trim().min(1).optional(),
  KEPT_BACKUP_KEEP: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(DEFAULT_KEEP),
});

export interface BackupConfig {
  dir: string;
  keep: number;
}

/** Scheduled backups are off unless `KEPT_BACKUP_DIR` is set. Invalid values throw. */
export function readBackupConfig(
  env: Record<string, string | undefined> = process.env,
): BackupConfig | null {
  const parsed = configSchema.safeParse({
    KEPT_BACKUP_DIR: env.KEPT_BACKUP_DIR || undefined,
    KEPT_BACKUP_KEEP: env.KEPT_BACKUP_KEEP || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid backup configuration (${problems})`);
  }
  if (!parsed.data.KEPT_BACKUP_DIR) return null;
  return {
    dir: parsed.data.KEPT_BACKUP_DIR,
    keep: parsed.data.KEPT_BACKUP_KEEP,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `kept-backup-YYYYMMDD-HHMMSS.db`, in UTC so names sort chronologically. */
export function backupFileName(date: Date = new Date()): string {
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `kept-backup-${day}-${time}.db`;
}

/** Writes a consistent, defragmented copy of the live database. `path` must not exist. */
export function writeBackup(db: DB, path: string): void {
  if (existsSync(path)) throw new Error("Backup target already exists");
  db.$client.run("VACUUM INTO ?", [path]);
}

export interface BackupDownload {
  fileName: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Backs up to a private temp file and returns it as a stream. The temp
 * directory is removed once the stream ends, fails or is cancelled.
 */
export function createBackupDownload(
  db: DB,
  now: Date = new Date(),
): BackupDownload {
  const dir = mkdtempSync(join(tmpdir(), "kept-backup-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const fileName = backupFileName(now);
    const path = join(dir, fileName);
    writeBackup(db, path);
    const size = statSync(path).size;
    const source = createReadStream(path);
    source.once("close", cleanup);
    return {
      fileName,
      size,
      stream: Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export interface BackupFile {
  name: string;
  size: number;
  /** Instant encoded in the file name. */
  createdAt: number;
}

/** Backups in `dir`, newest first. Unrelated files are ignored. */
export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  const files: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(name);
    if (!match) continue;
    const s = match[1];
    const createdAt = Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(9, 11),
      +s.slice(11, 13),
      +s.slice(13, 15),
    );
    files.push({ name, size: statSync(join(dir, name)).size, createdAt });
  }
  return files.sort((a, b) => b.createdAt - a.createdAt);
}

/** Deletes all but the newest `keep` backups (at least one is always kept); returns the deleted names. */
export function pruneBackups(dir: string, keep: number): string[] {
  const stale = listBackups(dir).slice(Math.max(keep, 1));
  for (const f of stale) rmSync(join(dir, f.name), { force: true });
  return stale.map((f) => f.name);
}

/** Writes a backup into `dir` (via a partial file, so a crash never leaves a broken backup) and prunes. */
export function runScheduledBackup(
  db: DB,
  config: BackupConfig,
  now: Date = new Date(),
): string {
  mkdirSync(config.dir, { recursive: true });
  const name = backupFileName(now);
  const partial = join(config.dir, `${name}.partial`);
  rmSync(partial, { force: true });
  try {
    writeBackup(db, partial);
    renameSync(partial, join(config.dir, name));
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  pruneBackups(config.dir, config.keep);
  return name;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/** A backup is due when the newest one is a day old (or none exists). */
export function isBackupDue(dir: string, now: number = Date.now()): boolean {
  const [latest] = listBackups(dir);
  return !latest || now - latest.createdAt >= DAY_MS;
}

/** Checks hourly and writes a backup when the newest is a day old. Returns a stop function. */
export function startBackupScheduler(
  getDb: () => DB,
  config: BackupConfig,
  options: { intervalMs?: number; firstRunDelayMs?: number } = {},
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      if (isBackupDue(config.dir)) runScheduledBackup(getDb(), config);
    } catch (err) {
      console.error(
        "scheduled backup failed",
        err instanceof Error ? err.message : "unknown error",
      );
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS);
  const timer = setInterval(tick, options.intervalMs ?? CHECK_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
