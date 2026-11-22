import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { ApiScope } from "$lib/api-tokens";
import {
  assertExpiry,
  assertOwnRestrictions,
} from "$lib/server/auth/api-tokens";
import { first, getDB, oauthAuthorizations, transaction } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { getClient } from "./clients";
import {
  CODE_TTL_MS,
  MAX_PENDING_REQUESTS_PER_USER,
  PENDING_REQUEST_TTL_MS,
  RESOURCE_PARAM_MAX,
  SCOPE_PARAM_MAX,
  STATE_MAX,
} from "./config";
import { assertConnectionRoom, countActiveConnections } from "./connections";
import { describeRedirectUri, matchRedirectUri } from "./redirect-uri";
import { DEFAULT_SCOPES, parseScopeParam } from "./scopes";
import { CODE_CHALLENGE, hashSecret, newAuthorizationCode } from "./secrets";
import { issuerOf, mcpResourceOf, isMcpResource } from "./urls";

/**
 * The authorization endpoint's logic. A request is validated once, when it
 * arrives (client, redirect URI, PKCE, resource), and stored for the signed-in
 * user. The consent page only ever refers to that stored request by its id:
 * nothing the browser submits later can change the client, the redirect URI,
 * the challenge or the resource the code is bound to.
 */

/** Parameters that must not be repeated (RFC 6749 section 3.1). */
const SINGLE_VALUED = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

export type BeginResult =
  /** The client or its redirect URI cannot be trusted: show an error, redirect nowhere. */
  | { kind: "invalid"; message: string }
  /** The request is wrong but the redirect URI is trusted: tell the client. */
  | { kind: "redirect"; location: string }
  /** The request is stored for this user; send them to the consent page. */
  | { kind: "consent"; id: string };

/** `redirectUri` with the given parameters added to its query (an existing query is kept). */
export function redirectWith(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.href;
}

/**
 * An error response to the client (RFC 6749 section 4.1.2.1); `iss` per RFC 9207.
 * Only a loopback redirect address (the app on this very device) is sent the
 * error. A request that never reached the consent page must not make a signed-in
 * owner's browser jump to any other registered address, so there the owner sees
 * the error instead.
 */
function errorRedirect(
  redirectUri: string,
  issuer: string,
  error: string,
  description: string,
  state: string | null,
): BeginResult {
  if (!describeRedirectUri(redirectUri).loopback) {
    return { kind: "invalid", message: description };
  }
  return {
    kind: "redirect",
    location: redirectWith(redirectUri, {
      error,
      error_description: description,
      state,
      iss: issuer,
    }),
  };
}

export async function beginAuthorization(
  userId: string,
  params: URLSearchParams,
  requestUrl: URL,
  now: number = Date.now(),
): Promise<BeginResult> {
  for (const name of SINGLE_VALUED) {
    if (params.getAll(name).length > 1) {
      return { kind: "invalid", message: "The request repeats a parameter." };
    }
  }
  const clientId = params.get("client_id");
  if (!clientId) {
    return { kind: "invalid", message: "The request names no application." };
  }
  const client = await getClient(clientId);
  if (!client) {
    return {
      kind: "invalid",
      message:
        "This application is not registered with this server. Remove the server in the application and add it again.",
    };
  }
  let redirectUri = params.get("redirect_uri");
  if (redirectUri === null) {
    const only =
      client.redirectUris.length === 1 ? client.redirectUris[0] : null;
    if (!only) {
      return {
        kind: "invalid",
        message: "The request has no redirect address.",
      };
    }
    redirectUri = only;
  } else if (!matchRedirectUri(client.redirectUris, redirectUri)) {
    return {
      kind: "invalid",
      message:
        "The redirect address does not match the one this application registered.",
    };
  }

  // From here on the redirect address is the client's own: a loopback one is told of problems, any other shows an error page.
  const issuer = issuerOf(requestUrl);
  const stateParam = params.get("state");
  const fail = (error: string, description: string, state = stateParam) =>
    errorRedirect(redirectUri, issuer, error, description, state);

  if (stateParam !== null && stateParam.length > STATE_MAX) {
    return fail("invalid_request", "The state parameter is too long.", null);
  }
  if (params.get("response_type") !== "code") {
    return fail(
      "unsupported_response_type",
      "Only the code response type is supported.",
    );
  }
  const challenge = params.get("code_challenge");
  if (!challenge || !CODE_CHALLENGE.test(challenge)) {
    return fail("invalid_request", "A PKCE code_challenge (S256) is required.");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "The code_challenge_method must be S256.");
  }
  const resources = params.getAll("resource");
  if (
    resources.some(
      (r) => r.length > RESOURCE_PARAM_MAX || !isMcpResource(r, requestUrl),
    )
  ) {
    return fail(
      "invalid_target",
      "The resource is not this server's MCP endpoint.",
    );
  }
  const scopeParam = params.get("scope");
  if (scopeParam !== null && scopeParam.length > SCOPE_PARAM_MAX) {
    return fail("invalid_scope", "The scope parameter is too long.");
  }

  const id = await transaction(
    async (tx) => {
      const pending = await tx
        .select({ id: oauthAuthorizations.id })
        .from(oauthAuthorizations)
        .where(
          and(
            eq(oauthAuthorizations.userId, userId),
            isNull(oauthAuthorizations.codeHash),
          ),
        )
        .orderBy(
          asc(oauthAuthorizations.createdAt),
          asc(oauthAuthorizations.id),
        );
      const drop = pending.length - (MAX_PENDING_REQUESTS_PER_USER - 1);
      if (drop > 0) {
        await tx.delete(oauthAuthorizations).where(
          inArray(
            oauthAuthorizations.id,
            pending.slice(0, drop).map((p) => p.id),
          ),
        );
      }
      const created = (await first(
        tx
          .insert(oauthAuthorizations)
          .values({
            userId,
            clientId: client.id,
            redirectUri,
            state: stateParam,
            codeChallenge: challenge,
            resource: mcpResourceOf(requestUrl),
            requestedScopes: parseScopeParam(scopeParam),
            expiresAt: new Date(now + PENDING_REQUEST_TTL_MS),
          })
          .returning({ id: oauthAuthorizations.id }),
      ))!;
      return created.id;
    },
    { lock: `oauth-authorizations:${userId}` },
  );
  return { kind: "consent", id };
}

export interface PendingConsent {
  id: string;
  clientName: string;
  clientUri: string | null;
  redirectUri: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  /** What to tick: what the client asked for, else every read permission. */
  scopes: ApiScope[];
  askedForScopes: boolean;
}

/** The user's stored request that is still waiting for consent, or null. */
export async function loadPendingConsent(
  userId: string,
  id: string,
  now: number = Date.now(),
): Promise<PendingConsent | null> {
  if (id.length === 0 || id.length > 128) return null;
  const row = await first(
    getDB()
      .select()
      .from(oauthAuthorizations)
      .where(
        and(
          eq(oauthAuthorizations.userId, userId),
          eq(oauthAuthorizations.id, id),
          isNull(oauthAuthorizations.codeHash),
        ),
      ),
  );
  if (!row || row.expiresAt.getTime() <= now) return null;
  const client = await getClient(row.clientId);
  if (!client || !matchRedirectUri(client.redirectUris, row.redirectUri)) {
    return null;
  }
  const where = describeRedirectUri(row.redirectUri);
  return {
    id: row.id,
    clientName: client.name,
    clientUri: client.clientUri,
    redirectUri: row.redirectUri,
    redirectHost: where.host,
    redirectIsLoopback: where.loopback,
    scopes:
      row.requestedScopes.length > 0
        ? row.requestedScopes
        : [...DEFAULT_SCOPES],
    askedForScopes: row.requestedScopes.length > 0,
  };
}

export interface ConsentChoice {
  scopes: ApiScope[];
  categoryIds: string[] | null;
  accountIds: string[] | null;
  expiresAt: Date | null;
}

/**
 * The owner approved: stores their choice and a one-time code on the stored
 * request, and returns where to send the browser. Everything the code is
 * bound to comes from the stored request.
 */
export async function approveAuthorization(
  userId: string,
  id: string,
  choice: ConsentChoice,
  requestUrl: URL,
  now: number = Date.now(),
): Promise<{ redirectTo: string }> {
  const code = newAuthorizationCode();
  const redirectTo = await transaction(
    async (tx) => {
      const row = await first(
        tx
          .select()
          .from(oauthAuthorizations)
          .where(
            and(
              eq(oauthAuthorizations.userId, userId),
              eq(oauthAuthorizations.id, id),
              isNull(oauthAuthorizations.codeHash),
            ),
          ),
      );
      if (!row || row.expiresAt.getTime() <= now) throw expired();
      const client = await getClient(row.clientId);
      if (!client || !matchRedirectUri(client.redirectUris, row.redirectUri)) {
        throw expired();
      }
      assertConnectionRoom(await countActiveConnections(tx, userId, now));
      assertExpiry(choice.expiresAt, now);
      await assertOwnRestrictions(
        tx,
        userId,
        choice.categoryIds,
        choice.accountIds,
      );
      const approved = await tx
        .update(oauthAuthorizations)
        .set({
          codeHash: hashSecret(code),
          approvedAt: new Date(now),
          expiresAt: new Date(now + CODE_TTL_MS),
          scopes: choice.scopes,
          categoryIds: choice.categoryIds,
          accountIds: choice.accountIds,
          connectionExpiresAt: choice.expiresAt,
        })
        .where(
          and(
            eq(oauthAuthorizations.id, row.id),
            isNull(oauthAuthorizations.codeHash),
          ),
        )
        .returning({ id: oauthAuthorizations.id });
      if (approved.length === 0) throw expired();
      return redirectWith(row.redirectUri, {
        code,
        state: row.state,
        iss: issuerOf(requestUrl),
      });
    },
    { lock: `oauth-authorizations:${userId}` },
  );
  return { redirectTo };
}

/** The owner refused: the stored request is dropped and the client is told `access_denied`. */
export async function denyAuthorization(
  userId: string,
  id: string,
  requestUrl: URL,
): Promise<{ redirectTo: string }> {
  const row = await first(
    getDB()
      .delete(oauthAuthorizations)
      .where(
        and(
          eq(oauthAuthorizations.userId, userId),
          eq(oauthAuthorizations.id, id),
          isNull(oauthAuthorizations.codeHash),
        ),
      )
      .returning({
        redirectUri: oauthAuthorizations.redirectUri,
        state: oauthAuthorizations.state,
      }),
  );
  if (!row) throw expired();
  return {
    redirectTo: redirectWith(row.redirectUri, {
      error: "access_denied",
      error_description: "The owner did not allow access.",
      state: row.state,
      iss: issuerOf(requestUrl),
    }),
  };
}

function expired(): LedgerError {
  return new LedgerError(
    "not_found",
    "This sign-in request has expired. Start again from the application.",
  );
}

/** Removes requests and codes that were never used or are long past. */
export async function sweepAuthorizations(
  retentionMs: number,
  now: number = Date.now(),
): Promise<void> {
  await getDB()
    .delete(oauthAuthorizations)
    .where(lt(oauthAuthorizations.expiresAt, new Date(now - retentionMs)));
}
