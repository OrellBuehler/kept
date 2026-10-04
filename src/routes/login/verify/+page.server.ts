import { fail, redirect } from "@sveltejs/kit";
import {
  PENDING_COOKIE,
  deletePendingCookie,
  deletePendingLogin,
  getPendingLogin,
} from "$lib/server/auth/challenges";
import {
  RateLimitedError,
  clientKey,
  completeSecondFactor,
} from "$lib/server/auth/login";
import { safeRedirectTo } from "$lib/server/auth/routing";
import { secondFactorSchema } from "$lib/server/auth/schemas";
import { invalidateSession, setSessionCookie } from "$lib/server/auth/sessions";
import { getTwoFactorStatus } from "$lib/server/auth/two-factor";
import { AuthError } from "$lib/server/auth/types";
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
  const redirectTo = safeRedirectTo(url.searchParams.get("redirectTo"));
  if (locals.user) redirect(303, redirectTo);
  const pending = await getPendingLogin(cookies.get(PENDING_COOKIE));
  if (!pending) {
    deletePendingCookie(cookies);
    redirect(303, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  }
  const status = await getTwoFactorStatus(pending.userId);
  return {
    redirectTo,
    totp: status.totpEnabled,
    passkeys: status.passkeyCount > 0,
  };
};

export const actions: Actions = {
  default: async ({ request, cookies, url, locals, getClientAddress }) => {
    const form = await request.formData();
    const redirectTo = safeRedirectTo(
      (form.get("redirectTo") as string | null) ??
        url.searchParams.get("redirectTo"),
    );
    const parsed = parseForm(secondFactorSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors });

    let result;
    try {
      result = await completeSecondFactor(
        cookies.get(PENDING_COOKIE),
        parsed.data.code,
        clientKey(getClientAddress),
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return fail(429, { errors: { form: [err.message] } });
      }
      if (err instanceof AuthError && err.code === "pending_expired") {
        deletePendingCookie(cookies);
        redirect(303, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);
      }
      throw err;
    }
    if (!result) {
      if (!(await getPendingLogin(cookies.get(PENDING_COOKIE)))) {
        deletePendingCookie(cookies);
        redirect(303, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);
      }
      return fail(400, { errors: { form: ["That code is not valid."] } });
    }

    deletePendingCookie(cookies);
    if (locals.session) await invalidateSession(locals.session.id);
    setSessionCookie(cookies, result.token, result.session.expiresAt);
    redirect(303, redirectTo);
  },

  cancel: async ({ cookies }) => {
    const pending = await getPendingLogin(cookies.get(PENDING_COOKIE));
    if (pending) await deletePendingLogin(pending.id);
    deletePendingCookie(cookies);
    redirect(303, "/login");
  },
};
