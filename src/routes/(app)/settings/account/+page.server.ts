import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { changePasswordSchema } from "$lib/server/auth/schemas";
import { RateLimitedError } from "$lib/server/auth/rate-limit";
import { AuthError } from "$lib/server/auth/types";
import { changePassword } from "$lib/server/auth/users";
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  return { user: requireUser(locals) };
};

export const actions: Actions = {
  changePassword: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(changePasswordSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });

    try {
      await changePassword(
        user.id,
        parsed.data.currentPassword,
        parsed.data.newPassword,
        locals.session?.id,
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return fail(429, { errors: { form: [err.message] } });
      }
      if (err instanceof AuthError && err.code === "invalid_credentials") {
        return fail(400, {
          errors: { currentPassword: ["Current password is incorrect."] },
        });
      }
      throw err;
    }
    return { success: true as const };
  },
};
