import { fail, redirect } from "@sveltejs/kit";
import { RateLimitedError, clientKey } from "$lib/server/auth/login";
import { setupLimiter } from "$lib/server/auth/rate-limit";
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

const ignore = () => undefined;
let queue: Promise<unknown> = Promise.resolve();

/** One password hash at a time: parallel setup attempts queue up and then see that setup is done. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.then(ignore, ignore);
  return next;
}

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress }) => {
    if (countUsers() > 0) redirect(303, "/login");
    const form = await request.formData();
    const values = safeValues(form, VALUE_FIELDS);
    const parsed = parseForm(setupSchema, form);
    if (!parsed.ok) return fail(400, { errors: parsed.errors, values });

    let release: () => void;
    try {
      release = setupLimiter.acquireOrThrow(
        "setup",
        clientKey(getClientAddress),
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return fail(429, { errors: { form: [err.message] }, values });
      }
      throw err;
    }

    let userId: string;
    try {
      userId = (
        await exclusive(async () => {
          if (countUsers() > 0) {
            throw new AuthError(
              "setup_closed",
              "Setup has already been completed.",
            );
          }
          return createFirstAdmin(parsed.data);
        })
      ).id;
    } catch (err) {
      if (err instanceof AuthError && err.code === "setup_closed") {
        redirect(303, "/login");
      }
      throw err;
    }
    release();

    const { token, session } = createSession(userId);
    setSessionCookie(cookies, token, session.expiresAt);
    redirect(303, "/");
  },
};
