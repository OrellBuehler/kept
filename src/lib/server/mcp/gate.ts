import { json, type RequestEvent } from "@sveltejs/kit";
import { runAsActor } from "$lib/server/audit/context";
import { verifyApiToken } from "$lib/server/auth/api-tokens";
import {
  actorOf,
  grantFromApiToken,
  grantFromConnection,
  type Grant,
} from "$lib/server/auth/grant";
import { LoginRateLimiter } from "$lib/server/auth/rate-limit";
import {
  asJsonError,
  authenticateCredential,
  bearerToken,
  noStore,
} from "$lib/server/external-api/gate";
import { configuredOrigin, publicOrigin } from "$lib/server/external-api/urls";
import { verifyAccessToken } from "$lib/server/oauth/connections";
import { isAccessToken } from "$lib/server/oauth/secrets";
import { resourceMetadataUrlOf } from "$lib/server/oauth/urls";

/**
 * Requests per token per minute. A model's turn is several requests (initialize,
 * the notification, tools/list, each tools/call), so this is higher than the
 * REST limit.
 */
export const MCP_REQUESTS_PER_MINUTE = 300;

export const mcpTokenLimiter = new LoginRateLimiter(
  Date.now,
  60_000,
  MCP_REQUESTS_PER_MINUTE,
  Infinity,
  Infinity,
);

/**
 * The URL of the OAuth protected-resource metadata of this server, advertised
 * in the `WWW-Authenticate` challenge so an OAuth-capable MCP client can find
 * the authorization server (RFC 9728).
 */
export function resourceMetadataUrl(origin: string): string {
  return resourceMetadataUrlOf(origin);
}

/** The 401 challenge; `invalidToken` marks that a credential was presented and refused (RFC 6750). */
export function mcpChallenge(origin: string, invalidToken = false): string {
  return [
    'Bearer realm="kept"',
    ...(invalidToken ? ['error="invalid_token"'] : []),
    `resource_metadata="${resourceMetadataUrl(origin)}"`,
  ].join(", ");
}

/**
 * Browser origins allowed past the Origin check, besides Kept's own
 * (`ORIGIN`): a comma-separated list in `KEPT_MCP_ALLOWED_ORIGINS`. The
 * endpoint sends no CORS headers, so this does not make a browser-based client
 * work; it only widens what the check lets through.
 */
function extraOrigins(
  env: string | undefined = process.env.KEPT_MCP_ALLOWED_ORIGINS,
): string[] {
  return (env ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o !== "");
}

/**
 * The Streamable HTTP transport requires servers to validate `Origin` so that a
 * web page cannot reach a server on a home network through DNS rebinding. A
 * request without an `Origin` (every non-browser client) passes. One with an
 * origin must be this instance's configured `ORIGIN` or listed in
 * `KEPT_MCP_ALLOWED_ORIGINS`. Without `ORIGIN` the request's own Host is
 * attacker-controlled under DNS rebinding, so it is never trusted as
 * "our own" origin.
 */
export function originRefusal(
  request: Request,
  env?: string,
  originEnv: string | undefined = process.env.ORIGIN,
): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const own = configuredOrigin(originEnv);
  const allowed = new Set([...(own ? [own] : []), ...extraOrigins(env)]);
  if (allowed.has(origin)) return null;
  return json({ message: "This origin is not allowed." }, { status: 403 });
}

export type McpAuth =
  { ok: true; grant: Grant } | { ok: false; response: Response };

/**
 * Turns the credential of a request into a grant. An OAuth access token is
 * recognised by its prefix and checked against its connection; everything else
 * is an API token. Both pass the same per-address refusal budget and a
 * per-credential request limit.
 */
export async function authenticateMcp(event: RequestEvent): Promise<McpAuth> {
  const origin = publicOrigin(event.url);
  const challenge = mcpChallenge(origin);
  const rejectedChallenge = mcpChallenge(origin, true);
  const presented = bearerToken(event.request.headers.get("authorization"));
  if (presented !== null && isAccessToken(presented)) {
    const auth = await authenticateCredential(event, {
      requests: mcpTokenLimiter,
      challenge,
      rejectedChallenge,
      verify: (token) => verifyAccessToken(token, event.url),
    });
    if (!auth.ok) return auth;
    return { ok: true, grant: grantFromConnection(auth.token) };
  }
  const auth = await authenticateCredential(event, {
    requests: mcpTokenLimiter,
    challenge,
    rejectedChallenge,
    verify: (token) => verifyApiToken(token),
  });
  if (!auth.ok) return auth;
  event.locals.apiToken = auth.token;
  return { ok: true, grant: grantFromApiToken(auth.token) };
}

/**
 * Authentication for `/api/mcp`: only `Authorization: Bearer` counts (an API
 * token or an OAuth access token), cookies never do (`locals.user` stays null). Applies to every method and path
 * under the prefix. Everything the request changes is attributed to this
 * connection in the change log.
 */
export async function handleMcpGate(
  event: RequestEvent,
  resolve: (event: RequestEvent) => Response | Promise<Response>,
): Promise<Response> {
  event.locals.user = null;
  event.locals.session = null;
  event.locals.apiToken = null;
  event.locals.grant = null;

  const refused = originRefusal(event.request);
  if (refused) return noStore(refused);

  const auth = await authenticateMcp(event);
  if (!auth.ok) return noStore(auth.response);

  event.locals.grant = auth.grant;
  return noStore(
    await runAsActor(actorOf(auth.grant, "mcp"), async () =>
      asJsonError(await resolve(event)),
    ),
  );
}
