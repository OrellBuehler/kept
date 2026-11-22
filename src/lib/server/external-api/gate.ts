import { json, type RequestEvent } from "@sveltejs/kit";
import { runAsActor } from "$lib/server/audit/context";
import { verifyApiToken, type ApiTokenAuth } from "$lib/server/auth/api-tokens";
import { actorOf, grantFromApiToken } from "$lib/server/auth/grant";
import { clientKey } from "$lib/server/auth/login";
import { LoginRateLimiter, WINDOW_MS } from "$lib/server/auth/rate-limit";

/** Requests per token per minute. */
export const API_REQUESTS_PER_MINUTE = 120;
/** Rejected tokens per client address per WINDOW_MS before that address is told to back off. */
export const API_AUTH_FAILURES_PER_IP = 20;

/** Counts every request of a token (never refunded); the "failures" of this limiter are requests. */
export const apiTokenLimiter = new LoginRateLimiter(
  Date.now,
  60_000,
  API_REQUESTS_PER_MINUTE,
  Infinity,
  Infinity,
);

/** Counts presented tokens that were refused; a request that authenticates gives its attempt back. */
export const apiAuthFailureLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  API_AUTH_FAILURES_PER_IP,
  API_AUTH_FAILURES_PER_IP,
  Infinity,
);

const CHALLENGE = 'Bearer realm="kept"';

export function unauthorized(
  message: string,
  challenge: string = CHALLENGE,
): Response {
  return json(
    { message },
    { status: 401, headers: { "www-authenticate": challenge } },
  );
}

export function tooManyRequests(
  retryAfterMs: number,
  message: string,
): Response {
  return json(
    { message },
    {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    },
  );
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Error responses SvelteKit renders itself (router 404, 405, unhandled errors)
 * negotiate on `Accept` and may be HTML; the external API always answers JSON.
 */
export async function asJsonError(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  if (response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }
  const headers = new Headers();
  const allow = response.headers.get("allow");
  if (allow) headers.set("allow", allow);
  const message =
    response.status >= 500
      ? "An unexpected error occurred."
      : response.status === 404
        ? "Not found"
        : response.status === 405
          ? "Method not allowed"
          : "Request failed";
  await response.body?.cancel();
  return json({ message }, { status: response.status, headers });
}

export function noStore(response: Response): Response {
  try {
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    // Immutable headers (e.g. a proxied fetch response): rebuild the response.
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
    copy.headers.set("cache-control", "no-store");
    return copy;
  }
}

export type BearerResult<T = ApiTokenAuth> =
  { ok: true; token: T } | { ok: false; response: Response };

/**
 * Authenticates the bearer credential of a token surface: the address's budget
 * for refused credentials, the check itself (`verify` looks the presented
 * string up) and the per-credential request limit. Shared by the external API
 * (API tokens) and the MCP server (API tokens and OAuth access tokens), so
 * every surface protects the same way and shares the per-address budget.
 */
export async function authenticateCredential<T extends { id: string }>(
  event: RequestEvent,
  options: {
    requests: LoginRateLimiter;
    challenge?: string;
    /** The challenge of a 401 for a credential that was presented and refused. */
    rejectedChallenge?: string;
    verify: (
      presented: string,
    ) => Promise<
      | { ok: true; token: T }
      | { ok: false; reason: "invalid" | "revoked" | "expired" }
    >;
  },
): Promise<BearerResult<T>> {
  const refuse = (message: string, rejected = true): BearerResult<T> => ({
    ok: false,
    response: unauthorized(
      message,
      (rejected ? options.rejectedChallenge : undefined) ?? options.challenge,
    ),
  });
  const presented = bearerToken(event.request.headers.get("authorization"));
  if (!presented) return refuse("A bearer token is required.", false);

  const ip = clientKey(event.getClientAddress);
  const attempt = apiAuthFailureLimiter.acquire(ip, ip);
  if (!attempt.allowed) {
    return {
      ok: false,
      response: tooManyRequests(
        attempt.retryAfterMs,
        "Too many rejected tokens, try again later.",
      ),
    };
  }
  let verified;
  try {
    verified = await options.verify(presented);
  } catch (err) {
    attempt.release();
    throw err;
  }
  if (!verified.ok) {
    // A token that exists but is revoked or expired is a stale client, not a guess: it
    // must not burn the address's budget and lock out clients with valid tokens.
    if (verified.reason !== "invalid") attempt.release();
    return refuse(
      verified.reason === "revoked"
        ? "This token has been revoked."
        : verified.reason === "expired"
          ? "This token has expired."
          : "The token is not valid.",
    );
  }
  attempt.release();

  const rate = options.requests.acquire(verified.token.id, verified.token.id);
  if (!rate.allowed) {
    return {
      ok: false,
      response: tooManyRequests(rate.retryAfterMs, "Rate limit exceeded."),
    };
  }
  return { ok: true, token: verified.token };
}

/** `authenticateCredential` for the `Authorization: Bearer kept_...` API tokens. */
export function authenticateBearer(
  event: RequestEvent,
  options: { requests: LoginRateLimiter; challenge?: string },
): Promise<BearerResult> {
  return authenticateCredential(event, {
    ...options,
    verify: (presented) => verifyApiToken(presented),
  });
}

/**
 * Authentication for `/api/external/v1/`: only `Authorization: Bearer kept_…`
 * counts. Session cookies are never read here, and `locals.user` stays null, so
 * no session-only handler can be reached with a token (nor a token handler with
 * a cookie). Applies to every method and every path under the prefix, routed or
 * not.
 */
export async function handleExternalApi(
  event: RequestEvent,
  resolve: (event: RequestEvent) => Response | Promise<Response>,
): Promise<Response> {
  event.locals.user = null;
  event.locals.session = null;
  event.locals.apiToken = null;
  event.locals.grant = null;

  const auth = await authenticateBearer(event, { requests: apiTokenLimiter });
  if (!auth.ok) return auth.response;

  const grant = grantFromApiToken(auth.token);
  event.locals.apiToken = auth.token;
  event.locals.grant = grant;
  return noStore(
    await runAsActor(actorOf(grant, "api"), async () =>
      asJsonError(await resolve(event)),
    ),
  );
}
