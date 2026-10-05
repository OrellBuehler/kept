import { getDB } from "$lib/server/db";
import { readDatabaseConfig } from "$lib/server/db/config";
import { readBackupConfig, startBackupScheduler } from "./backup";

let stop: (() => void) | null = null;

/** Starts daily backups when `KEPT_BACKUP_DIR` is set. Called once from the init hook. */
export function registerBackups(): void {
  if (stop) return;
  const config = readBackupConfig();
  if (!config) return;
  if (readDatabaseConfig().kind === "postgres") {
    // Backups copy the SQLite file; PostgreSQL is backed up with pg_dump or snapshots.
    console.warn(
      "KEPT_BACKUP_DIR is ignored with PostgreSQL: back the database up with pg_dump or a managed snapshot",
    );
    return;
  }
  const stopScheduler = startBackupScheduler(getDB, config);
  stop = () => {
    stopScheduler();
    stop = null;
  };
}
