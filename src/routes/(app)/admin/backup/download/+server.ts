import { error } from "@sveltejs/kit";
import { consumeDownloadToken } from "$lib/server/auth/admin-confirm";
import { recordAdminAction } from "$lib/server/auth/admin-audit";
import { requireAdmin } from "$lib/server/auth/guards";
import { createBackupDownload } from "$lib/server/backup/backup";
import { getDB } from "$lib/server/db";
import type { RequestHandler } from "./$types";
import { describeError } from "$lib/server/errors";

export const GET: RequestHandler = ({ locals, url }) => {
  const admin = requireAdmin(locals);
  if (!consumeDownloadToken(url.searchParams.get("token"), admin.id)) {
    error(403, "Confirm your password on the backup page to download.");
  }
  let download;
  try {
    download = createBackupDownload(getDB());
  } catch (err) {
    console.error("backup download failed", describeError(err));
    error(500, "The backup could not be created. Check the server log.");
  }
  recordAdminAction(admin, "backup_download");
  return new Response(download.stream, {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": String(download.size),
      "Content-Disposition": `attachment; filename="${download.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
};
