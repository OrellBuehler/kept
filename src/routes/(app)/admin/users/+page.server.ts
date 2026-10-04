import { fail } from "@sveltejs/kit";
import { adminConfirmMode } from "$lib/server/auth/admin-confirm";
import { adminConfirmationFailure } from "$lib/server/auth/admin-gate";
import {
  listAdminAuditLog,
  recordAdminAction,
} from "$lib/server/auth/admin-audit";
import { requireAdmin } from "$lib/server/auth/guards";
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
  assertCanDeleteUser,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  listUsers,
} from "$lib/server/auth/users";
import { getDB } from "$lib/server/db";
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
    confirmMode: adminConfirmMode(admin.id),
  };
};

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    const form = await request.formData();
    const values = safeValues(form, ["username", "role", "displayName"]);
    const parsed = parseForm(createUserSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    const { adminPassword, adminCode, ...input } = parsed.data;
    // Cheap preconditions first: a confirmation that cannot lead to a change
    // must not spend the TOTP step or a recovery code. createUser re-checks
    // inside its transaction.
    if (findUserByUsername(input.username)) {
      return fail(400, {
        errors: { username: ["Username is already taken."] },
        values,
      });
    }
    const refused = await adminConfirmationFailure(
      admin,
      locals.session?.id,
      { password: adminPassword, code: adminCode },
      values,
    );
    if (refused) return refused;

    try {
      const created = await createUser(input, (tx, user) =>
        recordAdminAction(
          admin,
          "user_create",
          { target: user, details: `role=${user.role}` },
          tx,
        ),
      );
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

    // Cheap preconditions before the confirmation spends a TOTP step or recovery
    // code; deleteUser re-checks them inside its transaction.
    try {
      assertCanDeleteUser(getDB(), admin.id, parsed.data.userId);
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(400, { errors: { form: [err.message] } });
      }
      throw err;
    }

    const refused = await adminConfirmationFailure(admin, locals.session?.id, {
      password: parsed.data.adminPassword,
      code: parsed.data.adminCode,
    });
    if (refused) return refused;

    try {
      deleteUser(admin.id, parsed.data.userId, (tx, target) =>
        recordAdminAction(
          admin,
          "user_delete",
          { target, details: `role=${target.role}` },
          tx,
        ),
      );
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(400, { errors: { form: [err.message] } });
      }
      throw err;
    }
    return { deleted: true as const };
  },

  resetTwoFactor: async ({ locals, request }) => {
    const admin = requireAdmin(locals);
    const parsed = parseForm(resetTwoFactorSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });

    // The target must exist before a confirmation spends a TOTP step or recovery
    // code; resetTwoFactor re-checks inside its transaction. Resetting yourself
    // is allowed (lost device), so only existence is checked.
    if (!findUserById(parsed.data.userId)) {
      return fail(400, { errors: { form: ["User not found."] } });
    }

    const refused = await adminConfirmationFailure(admin, locals.session?.id, {
      password: parsed.data.adminPassword,
      code: parsed.data.adminCode,
    });
    if (refused) return refused;

    try {
      resetTwoFactor(
        admin.id,
        parsed.data.userId,
        locals.session?.id,
        (tx, target) =>
          recordAdminAction(admin, "user_reset_two_factor", { target }, tx),
      );
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(400, { errors: { form: [err.message] } });
      }
      throw err;
    }
    return { twoFactorReset: true as const };
  },
};
