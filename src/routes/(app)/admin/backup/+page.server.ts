import { fail } from "@sveltejs/kit";
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
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const admin = requireAdmin(locals);
  const config = readBackupConfig();
  return {
    confirmMode: adminConfirmMode(admin.id),
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
    const parsed = parseForm(downloadSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    const refused = await adminConfirmationFailure(admin, locals.session?.id, {
      password: parsed.data.adminPassword,
      code: parsed.data.adminCode,
    });
    if (refused) return refused;
    const token = issueDownloadToken(admin.id);
    recordAdminAction(admin, "backup_link_issued");
    return {
      downloadUrl: `/admin/backup/download?token=${encodeURIComponent(token)}`,
    };
  },
};
