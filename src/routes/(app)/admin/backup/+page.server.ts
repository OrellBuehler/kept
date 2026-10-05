import { error, fail } from "@sveltejs/kit";
import { z } from "zod";
import { recordAdminAction } from "$lib/server/auth/admin-audit";
import {
  adminConfirmMode,
  issueDownloadToken,
} from "$lib/server/auth/admin-confirm";
import { adminConfirmationFailure } from "$lib/server/auth/admin-gate";
import { requireAdmin } from "$lib/server/auth/guards";
import { adminCodeSchema, adminPasswordSchema } from "$lib/server/auth/schemas";
import { listBackups, readBackupConfig } from "$lib/server/backup/backup";
import { dialect } from "$lib/server/db/dialect";
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const admin = requireAdmin(locals);
  const postgres = dialect === "pg";
  // Backups copy the SQLite file; with PostgreSQL the page only explains the alternatives.
  const config = postgres ? null : readBackupConfig();
  return {
    database: postgres ? ("postgres" as const) : ("sqlite" as const),
    confirmMode: await adminConfirmMode(admin.id),
    scheduled: config
      ? { dir: config.dir, keep: config.keep, backups: listBackups(config.dir) }
      : null,
  };
};

const downloadSchema = z.object({
  adminPassword: adminPasswordSchema,
  adminCode: adminCodeSchema,
});

export const actions: Actions = {
  /** Confirms the password and hands back a one-time link; the GET endpoint records the download. */
  download: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    if (dialect === "pg") error(404, "Not found");
    const parsed = parseForm(downloadSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    const refused = await adminConfirmationFailure(admin, locals.session?.id, {
      password: parsed.data.adminPassword,
      code: parsed.data.adminCode,
    });
    if (refused) return refused;
    const token = issueDownloadToken(admin.id);
    await recordAdminAction(admin, "backup_link_issued");
    return {
      downloadUrl: `/admin/backup/download?token=${encodeURIComponent(token)}`,
    };
  },
};
