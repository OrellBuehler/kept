import { fail, redirect } from "@sveltejs/kit";
import { setupSchema } from "$lib/server/auth/schemas";
import { createSession, setSessionCookie } from "$lib/server/auth/sessions";
import { AuthError } from "$lib/server/auth/types";
import { countUsers, createFirstAdmin } from "$lib/server/auth/users";
import { parseForm, safeValues } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

const VALUE_FIELDS = ["username", "displayName"] as const;

export const load: PageServerLoad = () => {
  if (countUsers() > 0) redirect(303, "/login");
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const values = safeValues(form, VALUE_FIELDS);
    const parsed = parseForm(setupSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    let userId: string;
    try {
      userId = (await createFirstAdmin(parsed.data)).id;
    } catch (err) {
      if (err instanceof AuthError && err.code === "setup_closed") {
        redirect(303, "/login");
      }
      throw err;
    }

    const { token, session } = createSession(userId);
    setSessionCookie(cookies, token, session.expiresAt);
    redirect(303, "/");
  },
};
