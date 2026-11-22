import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ApiScope } from "$lib/api-tokens";
import { getDB, mcpConnections } from "$lib/server/db";
import { handle } from "../../hooks.server";
import * as authorizePage from "../../routes/oauth/authorize/+page.server";
import * as metadataAs from "../../routes/.well-known/oauth-authorization-server/+server";
import * as metadataPr from "../../routes/.well-known/oauth-protected-resource/+server";
import * as metadataPrMcp from "../../routes/.well-known/oauth-protected-resource/api/mcp/+server";
import * as register from "../../routes/oauth/register/+server";
import * as revoke from "../../routes/oauth/revoke/+server";
import * as token from "../../routes/oauth/token/+server";
import type { TestUser } from "./auth";
import { createTestEvent, outcome, type Outcome } from "./event";

export const BASE = "http://localhost";
export const LOOPBACK = "http://127.0.0.1:53682/callback";

/** A PKCE pair (RFC 7636): the verifier a client keeps and the S256 challenge it sends. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

type Handlers = Record<string, ((e: never) => unknown) | undefined>;

const routes: Record<string, Handlers> = {
  "/oauth/register": register as unknown as Handlers,
  "/oauth/token": token as unknown as Handlers,
  "/oauth/revoke": revoke as unknown as Handlers,
  "/.well-known/oauth-authorization-server": metadataAs as unknown as Handlers,
  "/.well-known/oauth-protected-resource": metadataPr as unknown as Handlers,
  "/.well-known/oauth-protected-resource/api/mcp":
    metadataPrMcp as unknown as Handlers,
};

export interface OAuthCall {
  method?: string;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
  /** Sent as `application/json` (or as is, when a string). */
  json?: unknown;
  headers?: Record<string, string>;
  ip?: string;
  base?: string;
}

/** Sends a request through the real `handle` hook and the real route handler of a public OAuth path. */
export async function oauthCall(
  path: string,
  call: OAuthCall = {},
): Promise<Response> {
  const method = call.method ?? (call.form || call.json ? "POST" : "GET");
  const headers: Record<string, string> = { ...call.headers };
  let body: string | undefined;
  if (call.form) {
    headers["content-type"] ??= "application/x-www-form-urlencoded";
    body = new URLSearchParams(call.form).toString();
  } else if (call.json !== undefined) {
    headers["content-type"] ??= "application/json";
    body =
      typeof call.json === "string" ? call.json : JSON.stringify(call.json);
  }
  const event = createTestEvent({
    url: `${call.base ?? BASE}${path}`,
    method,
    headers,
    body,
    ip: call.ip,
  });
  const handler = routes[path]?.[method];
  const resolve = async () =>
    handler
      ? ((await handler(event as never)) as Response)
      : new Response("Method Not Allowed", { status: 405 });
  return handle({ event: event as never, resolve: resolve as never });
}

export async function body<T = Record<string, unknown>>(
  res: Response,
): Promise<T> {
  return (await res.json()) as T;
}

let registrations = 0;

/**
 * Registers a client the way an MCP client does and returns its id. Each call
 * comes from an address of its own unless `call.ip` says otherwise, so the
 * per-address registration limit does not get in the way of unrelated tests.
 */
export async function registerTestClient(
  over: Record<string, unknown> = {},
  call: OAuthCall = {},
): Promise<{ clientId: string; redirectUri: string; res: Response }> {
  const redirectUri =
    (over.redirect_uris as string[] | undefined)?.[0] ?? LOOPBACK;
  const res = await oauthCall("/oauth/register", {
    json: {
      client_name: "Test Client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...over,
    },
    ...call,
    ip:
      call.ip ?? `10.${(registrations >> 8) & 255}.${registrations++ & 255}.9`,
  });
  const out = (await res
    .clone()
    .json()
    .catch(() => ({}))) as {
    client_id?: string;
  };
  return { clientId: out.client_id ?? "", redirectUri, res };
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri?: string | null;
  challenge: string;
  scope?: string;
  state?: string;
  resource?: string | null;
  method?: string | null;
  responseType?: string | null;
}

/** The query string of an authorization request. */
export function authorizeQuery(p: AuthorizeParams): URLSearchParams {
  const q = new URLSearchParams();
  q.set("client_id", p.clientId);
  if (p.redirectUri !== null) q.set("redirect_uri", p.redirectUri ?? LOOPBACK);
  if (p.responseType !== null) q.set("response_type", p.responseType ?? "code");
  q.set("code_challenge", p.challenge);
  if (p.method !== null) q.set("code_challenge_method", p.method ?? "S256");
  if (p.scope !== undefined) q.set("scope", p.scope);
  if (p.state !== undefined) q.set("state", p.state);
  if (p.resource !== null) q.set("resource", p.resource ?? `${BASE}/api/mcp`);
  return q;
}

/** The authorize page's `load` for a signed-in user, with the given query. */
export function authorizeLoad(
  user: TestUser | null,
  query: URLSearchParams | string,
  method = "GET",
): Promise<Outcome> {
  const q = typeof query === "string" ? query : query.toString();
  return outcome(() =>
    authorizePage.load(
      createTestEvent({
        user,
        method,
        url: `${BASE}/oauth/authorize?${q}`,
      }) as never,
    ),
  );
}

type PageAction = "approve" | "deny";

/** A consent action (what the form posts) for a signed-in user. */
export function consentAction(
  action: PageAction,
  user: TestUser | null,
  consent: string,
  form: Record<string, string | string[]> = {},
  opts: { url?: string; session?: { id: string; expiresAt: Date } } = {},
): Promise<Outcome> {
  const fn = authorizePage.actions[action] as (e: never) => unknown;
  return outcome(() =>
    fn(
      createTestEvent({
        user,
        session: opts.session ?? null,
        form: { consent, ...form },
        url: opts.url ?? `${BASE}/oauth/authorize?/${action}`,
      }) as never,
    ),
  );
}

/** What a redirect back to the client carries. */
export function parseRedirect(location: string): URL {
  return new URL(location);
}

export interface Connected {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  connectionId: string;
  verifier: string;
  tokens: Record<string, unknown>;
}

/**
 * The whole flow for a signed-in user: register, authorize, approve, token.
 * `scopes` are ticked on the consent page (read-only by default, so no
 * confirmation is needed).
 */
export async function connect(
  user: TestUser,
  opts: {
    scopes?: readonly ApiScope[];
    categoryIds?: string[];
    accountIds?: string[];
    expires?: string;
    name?: string;
    password?: string;
  } = {},
): Promise<Connected> {
  const { clientId } = await registerTestClient(
    opts.name ? { client_name: opts.name } : {},
  );
  const { verifier, challenge } = pkce();
  const begun = await authorizeLoad(
    user,
    authorizeQuery({ clientId, challenge }),
  );
  if (begun.type !== "redirect") throw new Error("authorization not started");
  const consent = new URL(begun.location, BASE).searchParams.get("consent")!;
  const form: Record<string, string | string[]> = {
    scope: [...(opts.scopes ?? ["bills:read", "transactions:read"])],
  };
  if (opts.categoryIds) {
    form.restrict = "on";
    form.categoryId = opts.categoryIds;
  }
  if (opts.accountIds) {
    form.restrictAccounts = "on";
    form.accountId = opts.accountIds;
  }
  if (opts.expires) form.expires = opts.expires;
  if (opts.password) form.adminPassword = opts.password;
  const approved = await consentAction("approve", user, consent, form);
  if (approved.type !== "return") {
    throw new Error(`not approved: ${JSON.stringify(approved)}`);
  }
  const { redirectTo } = approved.value as { redirectTo: string };
  const code = parseRedirect(redirectTo).searchParams.get("code")!;
  const res = await oauthCall("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: LOOPBACK,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  const tokens = await body(res);
  if (res.status !== 200) {
    throw new Error(`no token: ${JSON.stringify(tokens)}`);
  }
  const [connection] = await getDB()
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(eq(mcpConnections.clientId, clientId));
  return {
    clientId,
    accessToken: tokens.access_token as string,
    refreshToken: tokens.refresh_token as string,
    connectionId: connection!.id,
    verifier,
    tokens,
  };
}
