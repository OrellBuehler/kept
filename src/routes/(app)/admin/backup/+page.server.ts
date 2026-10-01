import { requireAdmin } from "$lib/server/auth/guards";
import { listBackups, readBackupConfig } from "$lib/server/backup/backup";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requireAdmin(locals);
  const config = readBackupConfig();
  return {
    scheduled: config
      ? { dir: config.dir, keep: config.keep, backups: listBackups(config.dir) }
      : null,
  };
};
