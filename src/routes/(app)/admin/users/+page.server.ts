import { fail } from "@sveltejs/kit";
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
import { createUser, deleteUser, listUsers } from "$lib/server/auth/users";
import { parseForm, safeValues } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requireAdmin(locals);
  const withTwoFactor = usersWithTwoFactor();
  return {
    users: listUsers().map((u) => ({
      ...u,
      twoFactor: withTwoFactor.has(u.id),
    })),
  };
};

export const actions: Actions = {
  create: async ({ locals, request }) => {
    requireAdmin(locals);
    const form = await request.formData();
    const values = safeValues(form, ["username", "role", "displayName"]);
    const parsed = parseForm(createUserSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    try {
      const created = await createUser(parsed.data);
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

    try {
      deleteUser(admin.id, parsed.data.userId);
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

    try {
      resetTwoFactor(admin.id, parsed.data.userId, locals.session?.id);
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(400, { errors: { form: [err.message] } });
      }
      throw err;
    }
    return { twoFactorReset: true as const };
  },
};
