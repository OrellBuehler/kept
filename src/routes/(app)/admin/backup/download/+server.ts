import { error } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/guards";
import { createBackupDownload } from "$lib/server/backup/backup";
import { getDB } from "$lib/server/db";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ locals }) => {
  requireAdmin(locals);
  let download;
  try {
    download = createBackupDownload(getDB());
  } catch (err) {
    console.error(
      "backup download failed",
      err instanceof Error ? err.message : "unknown error",
    );
    error(500, "The backup could not be created. Check the server log.");
  }
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
