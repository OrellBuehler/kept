import { getDB } from "$lib/server/db";
import { readBackupConfig, startBackupScheduler } from "./backup";

let stop: (() => void) | null = null;

/** Starts daily backups when `KEPT_BACKUP_DIR` is set. Called once from the init hook. */
export function registerBackups(): void {
  if (stop) return;
  const config = readBackupConfig();
  if (!config) return;
  const stopScheduler = startBackupScheduler(getDB, config);
  stop = () => {
    stopScheduler();
    stop = null;
  };
}
