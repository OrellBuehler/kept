import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  closeDatabase,
  openDatabase,
  withExclusiveClient,
} from "$lib/server/db";
import { countUsers } from "$lib/server/auth/users";
import {
  backupFileName,
  createBackupDownload,
  isBackupDue,
  listBackups,
  pruneBackups,
  readBackupConfig,
  runScheduledBackup,
  startBackupScheduler,
  writeBackup,
} from "./backup";

const ctx = useTestDB();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kept-backup-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string) => new Date(iso);

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("backupFileName", () => {
  it("is a sortable UTC timestamp", () => {
    expect(backupFileName(at("2026-03-04T05:06:07Z"))).toBe(
      "kept-backup-20260304-050607.db",
    );
  });
});

describe("readBackupConfig", () => {
  it("is off without a directory", () => {
    expect(readBackupConfig({})).toBeNull();
    expect(readBackupConfig({ KEPT_BACKUP_DIR: "" })).toBeNull();
  });

  it("defaults to keeping 7", () => {
    expect(readBackupConfig({ KEPT_BACKUP_DIR: "/b" })).toEqual({
      dir: "/b",
      keep: 7,
    });
  });

  it("reads the keep count", () => {
    expect(
      readBackupConfig({ KEPT_BACKUP_DIR: "/b", KEPT_BACKUP_KEEP: "30" })?.keep,
    ).toBe(30);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects keep=%s", (keep) => {
    expect(() =>
      readBackupConfig({ KEPT_BACKUP_DIR: "/b", KEPT_BACKUP_KEEP: keep }),
    ).toThrow(/Invalid backup configuration/);
  });
});

describe("writeBackup", () => {
  it("produces a restorable copy of the live database", async () => {
    await createTestUser({ username: "alice" });
    const path = join(dir, "copy.db");
    await writeBackup(ctx.db, path);

    const copy = new Database(path, { readonly: true });
    expect(copy.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(copy.query("SELECT username FROM users").all()).toEqual([
      { username: "alice" },
    ]);
    const live = await withExclusiveClient((client) =>
      client.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
    );
    expect(
      copy.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
    ).toEqual(live);
    copy.close();
  });

  it("refuses to overwrite an existing file", async () => {
    const path = join(dir, "copy.db");
    writeFileSync(path, "x");
    await expect(writeBackup(ctx.db, path)).rejects.toThrow(/already exists/);
  });
});

describe("createBackupDownload", () => {
  it("streams a valid database and removes the temp directory afterwards", async () => {
    await createTestUser();
    const tmpRoot = mkdtempSync(join(dir, "tmp-"));
    const download = await createBackupDownload(
      ctx.db,
      at("2026-01-02T03:04:05Z"),
      tmpRoot,
    );
    expect(download.fileName).toBe("kept-backup-20260102-030405.db");

    const bytes = await readAll(download.stream);
    expect(bytes.byteLength).toBe(download.size);
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe(
      "SQLite format 3",
    );

    const path = join(dir, "downloaded.db");
    writeFileSync(path, bytes);
    const copy = new Database(path, { readonly: true });
    expect(copy.query("SELECT count(*) AS n FROM users").get()).toEqual({
      n: await countUsers(),
    });
    copy.close();

    await vi.waitFor(() => expect(readdirSync(tmpRoot)).toEqual([]));
  });

  it("removes the temp directory when the client cancels", async () => {
    const tmpRoot = mkdtempSync(join(dir, "tmp-"));
    const download = await createBackupDownload(ctx.db, new Date(), tmpRoot);
    expect(readdirSync(tmpRoot)).toHaveLength(1);
    await download.stream.cancel();
    await vi.waitFor(() => expect(readdirSync(tmpRoot)).toEqual([]));
  });
});

describe("listBackups and pruneBackups", () => {
  const touch = (name: string) => writeFileSync(join(dir, name), "x");

  it("lists newest first and ignores unrelated files", () => {
    touch("kept-backup-20260101-000000.db");
    touch("kept-backup-20260103-000000.db");
    touch("kept-backup-20260102-000000.db");
    touch("notes.txt");
    touch("kept-backup-20260104-000000.db.partial");
    expect(listBackups(dir).map((f) => f.name)).toEqual([
      "kept-backup-20260103-000000.db",
      "kept-backup-20260102-000000.db",
      "kept-backup-20260101-000000.db",
    ]);
  });

  it("returns nothing for a missing directory", () => {
    expect(listBackups(join(dir, "missing"))).toEqual([]);
  });

  it("deletes only the oldest backups beyond keep", () => {
    for (const d of ["01", "02", "03", "04"])
      touch(`kept-backup-202601${d}-000000.db`);
    touch("notes.txt");
    expect(pruneBackups(dir, 2)).toEqual([
      "kept-backup-20260102-000000.db",
      "kept-backup-20260101-000000.db",
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      "kept-backup-20260103-000000.db",
      "kept-backup-20260104-000000.db",
      "notes.txt",
    ]);
  });

  it("always keeps at least one backup", () => {
    touch("kept-backup-20260101-000000.db");
    touch("kept-backup-20260102-000000.db");
    pruneBackups(dir, 0);
    expect(listBackups(dir)).toHaveLength(1);
  });
});

describe("runScheduledBackup", () => {
  it("creates the directory, writes the backup and prunes", async () => {
    await createTestUser();
    const config = { dir: join(dir, "nested", "backups"), keep: 2 };
    await runScheduledBackup(ctx.db, config, at("2026-01-01T00:00:00Z"));
    await runScheduledBackup(ctx.db, config, at("2026-01-02T00:00:00Z"));
    const name = await runScheduledBackup(
      ctx.db,
      config,
      at("2026-01-03T00:00:00Z"),
    );

    expect(name).toBe("kept-backup-20260103-000000.db");
    expect(readdirSync(config.dir).sort()).toEqual([
      "kept-backup-20260102-000000.db",
      "kept-backup-20260103-000000.db",
    ]);
    const copy = new Database(join(config.dir, name), { readonly: true });
    expect(copy.query("SELECT count(*) AS n FROM users").get()).toEqual({
      n: 1,
    });
    copy.close();
  });

  it("leaves no partial file and keeps old backups when writing fails", async () => {
    const config = { dir, keep: 1 };
    await runScheduledBackup(ctx.db, config, at("2026-01-01T00:00:00Z"));
    // A closed handle makes VACUUM INTO fail after the partial path was chosen.
    const broken = openDatabase(":memory:");
    await closeDatabase(broken);
    await expect(
      runScheduledBackup(broken, config, at("2026-01-02T00:00:00Z")),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["kept-backup-20260101-000000.db"]);
  });
});

describe("isBackupDue", () => {
  it("is due when there is no backup or the newest is a day old", () => {
    expect(isBackupDue(dir)).toBe(true);
    writeFileSync(join(dir, "kept-backup-20260101-120000.db"), "x");
    const base = Date.UTC(2026, 0, 1, 12);
    expect(isBackupDue(dir, base + 23 * 3600_000)).toBe(false);
    expect(isBackupDue(dir, base + 24 * 3600_000)).toBe(true);
  });
});

describe("startBackupScheduler", () => {
  it("writes a backup on the first tick and not again until due", async () => {
    const stop = startBackupScheduler(
      () => ctx.db,
      { dir, keep: 3 },
      { firstRunDelayMs: 5, intervalMs: 10 },
    );
    await vi.waitFor(() => expect(listBackups(dir)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(listBackups(dir)).toHaveLength(1);
  });

  it("logs failures without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startBackupScheduler(
      () => {
        throw new Error("no database");
      },
      { dir, keep: 3 },
      { firstRunDelayMs: 5, intervalMs: 1000 },
    );
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("scheduled backup failed", "Error"),
    );
    stop();
    error.mockRestore();
    expect(existsSync(dir)).toBe(true);
  });
});
