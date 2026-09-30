import { json, type Handle } from "@sveltejs/kit";
import { assertSecretKeyConfigured } from "$lib/server/crypto";
import { runMigrations } from "$lib/server/db";
import {
  SESSION_COOKIE,
  deleteSessionCookie,
  setSessionCookie,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { isApiPath, isPublicPath } from "$lib/server/auth/routing";
import { countUsers } from "$lib/server/auth/users";

export function init() {
  assertSecretKeyConfigured();
  runMigrations();
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.session = null;

  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    const validated = validateSessionToken(token);
    if (validated) {
      event.locals.user = validated.user;
      event.locals.session = validated.session;
      if (validated.refreshed) {
        setSessionCookie(event.cookies, token, validated.session.expiresAt);
      }
    } else {
      deleteSessionCookie(event.cookies);
    }
  }

  const { pathname, search } = event.url;
  if (event.locals.user || isPublicPath(pathname)) return resolve(event);

  if (countUsers() === 0) return redirectResponse("/setup");

  if (isApiPath(pathname)) {
    return json({ message: "Authentication required" }, { status: 401 });
  }
  return redirectResponse(
    `/login?redirectTo=${encodeURIComponent(pathname + search)}`,
  );
};
