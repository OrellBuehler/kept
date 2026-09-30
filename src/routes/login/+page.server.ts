import { fail, redirect } from "@sveltejs/kit";
import { RateLimitedError, authenticate } from "$lib/server/auth/login";
import { safeRedirectTo } from "$lib/server/auth/routing";
import { loginSchema } from "$lib/server/auth/schemas";
import { setSessionCookie } from "$lib/server/auth/sessions";
import { parseForm, safeValues } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const redirectTo = safeRedirectTo(url.searchParams.get("redirectTo"));
  if (locals.user) redirect(303, redirectTo);
  return { redirectTo };
};

export const actions: Actions = {
  default: async ({ request, cookies, url, getClientAddress }) => {
    const form = await request.formData();
    const values = safeValues(form, ["username"]);
    const parsed = parseForm(loginSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    let result;
    try {
      result = await authenticate(
        parsed.data.username,
        parsed.data.password,
        getClientAddress(),
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return fail(429, { errors: { form: [err.message] }, values });
      }
      throw err;
    }
    if (!result) {
      return fail(400, {
        errors: { form: ["Invalid username or password."] },
        values,
      });
    }

    setSessionCookie(cookies, result.token, result.session.expiresAt);
    redirect(
      303,
      safeRedirectTo(
        parsed.data.redirectTo ?? url.searchParams.get("redirectTo"),
      ),
    );
  },
};
