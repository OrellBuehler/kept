import { fail } from "@sveltejs/kit";
import { confirmAdminPassword } from "$lib/server/auth/admin-confirm";
import {
  listAdminAuditLog,
  recordAdminAction,
} from "$lib/server/auth/admin-audit";
import { requireAdmin } from "$lib/server/auth/guards";
import { RateLimitedError } from "$lib/server/auth/rate-limit";
import {
  createUserSchema,
  deleteUserSchema,
  resetTwoFactorSchema,
} from "$lib/server/auth/schemas";
import { AuthError } from "$lib/server/auth/types";
import {
  resetTwoFactor,
  usersWithTwoFactor,
} from "$lib/server/auth/two-factor";
import {
  createUser,
  deleteUser,
  findUserById,
  listUsers,
} from "$lib/server/auth/users";
import { parseForm, safeValues } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const admin = requireAdmin(locals);
  const withTwoFactor = usersWithTwoFactor();
  return {
    users: listUsers().map((u) => ({
      ...u,
      twoFactor: withTwoFactor.has(u.id),
    })),
    audit: listAdminAuditLog(admin),
  };
};

/** Null when the password is right; otherwise the failure to return from the action. */
async function confirmationFailure(
  adminId: string,
  password: string,
  values?: Record<string, string>,
) {
  try {
    await confirmAdminPassword(adminId, password);
    return null;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return fail(429, { errors: { form: [err.message] }, values });
    }
    if (err instanceof AuthError && err.code === "invalid_credentials") {
      return fail(400, {
        errors: { adminPassword: ["Your password is incorrect."] },
        values,
      });
    }
    throw err;
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    const form = await request.formData();
    const values = safeValues(form, ["username", "role", "displayName"]);
    const parsed = parseForm(createUserSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    const { adminPassword, ...input } = parsed.data;
    const refused = await confirmationFailure(admin.id, adminPassword, values);
    if (refused) return refused;

    try {
      const created = await createUser(input);
      recordAdminAction(admin, "user_create", {
        target: created,
        details: `role=${created.role}`,
      });
      return { created: true as const, username: created.username };
    } catch (err) {
      if (err instanceof AuthError && err.code === "username_taken") {
        return fail(400, { errors: { username: [err.message] }, values });
      }
      throw err;
    }
  },

  delete: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    const parsed = parseForm(deleteUserSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });

    const refused = await confirmationFailure(
      admin.id,
      parsed.data.adminPassword,
    );
    if (refused) return refused;

    const target = findUserById(parsed.data.userId);
    try {
      deleteUser(admin.id, parsed.data.userId);
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(400, { errors: { form: [err.message] } });
      }
      throw err;
    }
    if (target) {
      recordAdminAction(admin, "user_delete", {
        target,
        details: `role=${target.role}`,
      });
    }
    return { deleted: true as const };
  },

  resetTwoFactor: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    const parsed = parseForm(resetTwoFactorSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });

    const refused = await confirmationFailure(
      admin.id,
      parsed.data.adminPassword,
    );
    if (refused) return refused;

    try {
      resetTwoFactor(admin.id, parsed.data.userId, locals.session?.id);
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(400, { errors: { form: [err.message] } });
      }
      throw err;
    }
    const target = findUserById(parsed.data.userId);
    if (target) recordAdminAction(admin, "user_reset_two_factor", { target });
    return { twoFactorReset: true as const };
  },
};
