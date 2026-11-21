import type { RequestEvent } from "@sveltejs/kit";
import { clientKey } from "$lib/server/auth/login";
import { LoginRateLimiter, WINDOW_MS } from "$lib/server/auth/rate-limit";
import { isPublicAppApiPath } from "$lib/server/auth/routing";
import { validateSessionToken } from "$lib/server/auth/sessions";
import {
  asJsonError,
  bearerToken,
  noStore,
  tooManyRequests,
  unauthorized,
} from "$lib/server/external-api/gate";

/** Session tokens as `generateToken` makes them: 32 random bytes, base64url. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Bearers that cannot be a session token, per client address per WINDOW_MS, before that address is told to back off. */
export const APP_AUTH_FAILURES_PER_IP = 20;

export const appAuthFailureLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  APP_AUTH_FAILURES_PER_IP,
  APP_AUTH_FAILURES_PER_IP,
  Infinity,
);

/**
 * Authentication for `/api/app/v1/`, the API of the mobile apps: the session
 * token travels as `Authorization: Bearer`, cookies are never read (so no
 * browser can be tricked into a request), and an API token (`kept_…`) is not a
 * session. Every answer is JSON and uncached, except the files the bridge
 * passes through.
 */
export async function handleAppApi(
  event: RequestEvent,
  resolve: (event: RequestEvent) => Response | Promise<Response>,
): Promise<Response> {
  event.locals.user = null;
  event.locals.session = null;
  event.locals.apiToken = null;

  if (isPublicAppApiPath(event.url.pathname)) {
    return noStore(await asJsonError(await resolve(event)));
  }

  const presented = bearerToken(event.request.headers.get("authorization"));
  if (!presented) return noStore(unauthorized("Sign in to continue."));

  if (!SESSION_TOKEN.test(presented)) {
    const ip = clientKey(event.getClientAddress);
    const attempt = appAuthFailureLimiter.acquire(ip, ip);
    if (!attempt.allowed) {
      return noStore(
        tooManyRequests(
          attempt.retryAfterMs,
          "Too many rejected sessions, try again later.",
        ),
      );
    }
    return noStore(unauthorized("The session token is not valid."));
  }

  const validated = await validateSessionToken(presented);
  if (!validated) {
    return noStore(unauthorized("The session has ended. Sign in again."));
  }

  event.locals.user = validated.user;
  event.locals.session = validated.session;
  return noStore(await asJsonError(await resolve(event)));
}
