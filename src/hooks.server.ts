import { json, type Handle, type HandleServerError } from "@sveltejs/kit";
import { warmDummyHash } from "$lib/server/auth/password";
import { assertSecretKeyConfigured } from "$lib/server/crypto";
import { registerBackups } from "$lib/server/backup";
import { registerInbox } from "$lib/server/inbox";
import { runMigrations } from "$lib/server/db";
import { registerNotifications } from "$lib/server/notifications";
import { registerPaperless } from "$lib/server/integrations/paperless";
import { registerMarketData } from "$lib/server/integrations/yahoo-finance";
import {
  SESSION_COOKIE,
  clearedSessionCookieHeader,
  deleteSessionCookie,
  setSessionCookie,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { isApiPath, isPublicPath } from "$lib/server/auth/routing";
import { describeError } from "$lib/server/errors";
import { countUsers } from "$lib/server/auth/users";

export async function init() {
  assertSecretKeyConfigured();
  runMigrations();
  registerBackups();
  registerInbox();
  await warmDummyHash();
  registerPaperless();
  registerMarketData();
  registerNotifications();
}

export const handleError: HandleServerError = ({ error, event, status }) => {
  const errorId = crypto.randomUUID();
  console.error(
    `unhandled error ${errorId} status=${status} route=${event.route.id ?? "none"}`,
    describeError(error),
  );
  return { message: "An unexpected error occurred.", errorId };
};

function redirectResponse(location: string, clearCookie?: string): Response {
  const headers = new Headers({ location });
  if (clearCookie) headers.append("set-cookie", clearCookie);
  return new Response(null, { status: 303, headers });
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.session = null;

  const token = event.cookies.get(SESSION_COOKIE);
  let staleCookie: string | undefined;
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
      // Early returns below bypass resolve(), so the cookie jar is not applied.
      staleCookie = clearedSessionCookieHeader(event.cookies);
    }
  }

  const { pathname, search } = event.url;
  if (event.locals.user || isPublicPath(pathname)) return resolve(event);

  if (countUsers() === 0) return redirectResponse("/setup", staleCookie);

  if (isApiPath(pathname)) {
    const res = json({ message: "Authentication required" }, { status: 401 });
    if (staleCookie) res.headers.append("set-cookie", staleCookie);
    return res;
  }
  return redirectResponse(
    `/login?redirectTo=${encodeURIComponent(pathname + search)}`,
    staleCookie,
  );
};
