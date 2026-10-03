import { fail, redirect } from "@sveltejs/kit";
import {
  RateLimitedError,
  authenticate,
  clientKey,
} from "$lib/server/auth/login";
import { setPendingCookie } from "$lib/server/auth/challenges";
import { safeRedirectTo } from "$lib/server/auth/routing";
import { loginSchema } from "$lib/server/auth/schemas";
import { invalidateSession, setSessionCookie } from "$lib/server/auth/sessions";
import { parseForm, safeValues } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const redirectTo = safeRedirectTo(url.searchParams.get("redirectTo"));
  if (locals.user) redirect(303, redirectTo);
  return { redirectTo };
};

export const actions: Actions = {
  default: async ({ request, cookies, url, locals, getClientAddress }) => {
    const form = await request.formData();
    const values = safeValues(form, ["username"]);
    const parsed = parseForm(loginSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    let result;
    try {
      result = await authenticate(
        parsed.data.username,
        parsed.data.password,
        clientKey(getClientAddress),
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

    const redirectTo = safeRedirectTo(
      parsed.data.redirectTo ?? url.searchParams.get("redirectTo"),
    );
    if ("secondFactorRequired" in result) {
      setPendingCookie(cookies, result.token, result.expiresAt);
      redirect(
        303,
        `/login/verify?redirectTo=${encodeURIComponent(redirectTo)}`,
      );
    }

    if (locals.session) invalidateSession(locals.session.id);
    setSessionCookie(cookies, result.token, result.session.expiresAt);
    redirect(303, redirectTo);
  },
};
