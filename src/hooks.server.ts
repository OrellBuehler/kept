import { json } from "@sveltejs/kit";
import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import { warmDummyHash } from "$lib/server/auth/password";
import { assertSecretKeyConfigured } from "$lib/server/crypto";
import { registerBackups, stopBackups } from "$lib/server/backup";
import { registerInbox, stopInbox } from "$lib/server/inbox";
import { startDocumentSweep } from "$lib/server/bills/documents";
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
import {
  isApiPath,
  isAppApiPath,
  isExternalApiPath,
  isMcpPath,
  isPublicPath,
} from "$lib/server/auth/routing";
import { runAsActor } from "$lib/server/audit/context";
import { handleAppApi } from "$lib/server/app-api/gate";
import { handleExternalApi } from "$lib/server/external-api/gate";
import { sweepOrphanedLinks } from "$lib/server/external-api/links";
import {
  registerHeldDocumentSweep,
  unregisterHeldDocumentSweep,
} from "$lib/server/bills/held-documents";
import { handleMcpGate } from "$lib/server/mcp/gate";
import {
  registerOAuthSweep,
  unregisterOAuthSweep,
} from "$lib/server/oauth/maintenance";
import { csrfRefusal } from "$lib/server/csrf";
import { describeError } from "$lib/server/errors";
import {
  warnIfAddressHeaderUnset,
  warnIfProxied,
} from "$lib/server/auth/login";
import {
  installShutdownHandler,
  onShutdown,
  trackRequest,
} from "$lib/server/lifecycle";
import { withSecurityHeaders } from "$lib/server/security-headers";
import { countUsers } from "$lib/server/auth/users";

export async function init() {
  assertSecretKeyConfigured();
  getStore();
  warnIfAddressHeaderUnset();
  await runMigrations();
  startPendingSweep();
  startDocumentSweep();
  sweepStaleStorageTemp().catch((err) =>
    console.error("storage temp cleanup failed: %s", describeError(err)),
  );
  sweepOrphanedLinks().catch((err) =>
    console.error("external link cleanup failed: %s", describeError(err)),
  );
  registerBackups();
  registerInbox();
  await warmDummyHash();
  registerPaperless();
  registerMarketData();
  registerNotifications();
  registerOAuthSweep();
  registerHeldDocumentSweep();
  onShutdown("backups", stopBackups);
  onShutdown("inbox scan", stopInbox);
  onShutdown("paperless sync", unregisterPaperless);
  onShutdown("market data refresh", unregisterMarketData);
  onShutdown("notifications", unregisterNotifications);
  onShutdown("oauth sweep", unregisterOAuthSweep);
  onShutdown("held document sweep", unregisterHeldDocumentSweep);
  installShutdownHandler();
}

export const handleError: HandleServerError = (input) => {
  if (input.kind === "app") return;
  const { error, event } = input;
  const status = input.kind === "unknown" ? 500 : input.error.status;
  const errorId = crypto.randomUUID();
  const bridged = event.locals.appRoute
    ? ` bridged=${event.locals.appRoute}`
    : "";
  console.error(
    `unhandled error ${errorId} status=${status} route=${event.route.id ?? "none"}${bridged}`,
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
  // SvelteKit's own check is off (vite.config.ts) so that OAuth clients can post
  // their token request without an Origin; this is the same check, minus those endpoints.
  if (!import.meta.env.DEV) {
    const forbidden = csrfRefusal(event.request, event.url);
    if (forbidden) return forbidden;
  }
  if (isExternalApiPath(event.url.pathname)) {
    return handleExternalApi(event, resolve);
  }
  if (isMcpPath(event.url.pathname)) {
    return handleMcpGate(event, resolve);
  }
  if (isAppApiPath(event.url.pathname)) {
    return handleAppApi(event, resolve);
  }
  event.locals.user = null;
  event.locals.session = null;
  event.locals.apiToken = null;

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
  if (event.locals.user) {
    const actor = { kind: "web", userId: event.locals.user.id } as const;
    return runAsActor(actor, () => resolve(event));
  }
  if (isPublicPath(pathname)) return resolve(event);

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

export const handle: Handle = (input) =>
  trackRequest(async () =>
    withSecurityHeaders(await handleRequest(input), input.event.url),
  );
