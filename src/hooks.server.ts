import { json, type Handle, type HandleServerError } from "@sveltejs/kit";
import { warmDummyHash } from "$lib/server/auth/password";
import { assertSecretKeyConfigured } from "$lib/server/crypto";
import { registerBackups, stopBackups } from "$lib/server/backup";
import { registerInbox, stopInbox } from "$lib/server/inbox";
import { startPendingSweep } from "$lib/server/imports";
import { runMigrations } from "$lib/server/db";
import { getStore, sweepStaleStorageTemp } from "$lib/server/storage";
import {
  registerNotifications,
  unregisterNotifications,
} from "$lib/server/notifications";
import {
  registerPaperless,
  unregisterPaperless,
} from "$lib/server/integrations/paperless";
import {
  registerMarketData,
  unregisterMarketData,
} from "$lib/server/integrations/yahoo-finance";
import {
  SESSION_COOKIE,
  clearedSessionCookieHeader,
  deleteSessionCookie,
  setSessionCookie,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { isApiPath, isPublicPath } from "$lib/server/auth/routing";
import { describeError } from "$lib/server/errors";
import {
  warnIfAddressHeaderUnset,
  warnIfProxied,
} from "$lib/server/auth/login";
import { installShutdownHandler, onShutdown } from "$lib/server/lifecycle";
import { withSecurityHeaders } from "$lib/server/security-headers";
import { countUsers } from "$lib/server/auth/users";

export async function init() {
  assertSecretKeyConfigured();
  getStore();
  warnIfAddressHeaderUnset();
  await runMigrations();
  startPendingSweep();
  sweepStaleStorageTemp().catch((err) =>
    console.error("storage temp cleanup failed: %s", describeError(err)),
  );
  registerBackups();
  registerInbox();
  await warmDummyHash();
  registerPaperless();
  registerMarketData();
  registerNotifications();
  onShutdown("backups", stopBackups);
  onShutdown("inbox scan", stopInbox);
  onShutdown("paperless sync", unregisterPaperless);
  onShutdown("market data refresh", unregisterMarketData);
  onShutdown("notifications", unregisterNotifications);
  installShutdownHandler();
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

async function handleRequest({
  event,
  resolve,
}: Parameters<Handle>[0]): Promise<Response> {
  warnIfProxied(event.request.headers);
  event.locals.user = null;
  event.locals.session = null;

  const token = event.cookies.get(SESSION_COOKIE);
  let staleCookie: string | undefined;
  if (token) {
    const validated = await validateSessionToken(token);
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

  if ((await countUsers()) === 0)
    return redirectResponse("/setup", staleCookie);

  if (isApiPath(pathname)) {
    const res = json({ message: "Authentication required" }, { status: 401 });
    if (staleCookie) res.headers.append("set-cookie", staleCookie);
    return res;
  }
  return redirectResponse(
    `/login?redirectTo=${encodeURIComponent(pathname + search)}`,
    staleCookie,
  );
}

export const handle: Handle = async (input) =>
  withSecurityHeaders(await handleRequest(input), input.event.url);
