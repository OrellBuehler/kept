import { fail } from "@sveltejs/kit";
import { z } from "zod";
import {
  confirmAdminPassword,
  issueDownloadToken,
} from "$lib/server/auth/admin-confirm";
import { requireAdmin } from "$lib/server/auth/guards";
import { RateLimitedError } from "$lib/server/auth/rate-limit";
import { adminPasswordSchema } from "$lib/server/auth/schemas";
import { AuthError } from "$lib/server/auth/types";
import { listBackups, readBackupConfig } from "$lib/server/backup/backup";
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requireAdmin(locals);
  const config = readBackupConfig();
  return {
    scheduled: config
      ? { dir: config.dir, keep: config.keep, backups: listBackups(config.dir) }
      : null,
  };
};

const downloadSchema = z.object({ adminPassword: adminPasswordSchema });

export const actions: Actions = {
  /** Confirms the password and hands back a one-time link; the GET endpoint records the download. */
  download: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    const parsed = parseForm(downloadSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await confirmAdminPassword(admin.id, parsed.data.adminPassword);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return fail(429, { errors: { form: [err.message] } });
      }
      if (err instanceof AuthError && err.code === "invalid_credentials") {
        return fail(400, {
          errors: { adminPassword: ["Your password is incorrect."] },
        });
      }
      throw err;
    }
    const token = issueDownloadToken(admin.id);
    return {
      downloadUrl: `/admin/backup/download?token=${encodeURIComponent(token)}`,
    };
  },
};
