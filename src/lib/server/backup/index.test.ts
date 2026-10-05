import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBackups } from "./index";
import * as backup from "./backup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerBackups", () => {
  it("skips the SQLite scheduler with PostgreSQL and says why", () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@db.example.invalid/kept");
    vi.stubEnv("KEPT_BACKUP_DIR", "/tmp/kept-backups");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const start = vi.spyOn(backup, "startBackupScheduler");
    registerBackups();
    expect(start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("pg_dump");
    expect(String(warn.mock.calls[0]![0])).not.toContain("p@");
  });

  it("stays quiet with PostgreSQL when no backup directory is set", () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@db.example.invalid/kept");
    vi.stubEnv("KEPT_BACKUP_DIR", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBackups();
    expect(warn).not.toHaveBeenCalled();
  });
});
