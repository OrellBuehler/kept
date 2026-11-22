import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { API_SCOPES, type ApiScope } from "$lib/api-tokens";
import { logAuthEventInTx } from "$lib/server/auth/events";
import {
  first,
  mcpConnections,
  oauthAuthorizations,
  oauthTokens,
  transaction,
} from "$lib/server/db";
import { getClient } from "./clients";
import {
  ACCESS_TOKEN_TTL_MS,
  MAX_ACTIVE_CONNECTIONS,
  REFRESH_TOKEN_TTL_MS,
  RESOURCE_PARAM_MAX,
  SCOPE_PARAM_MAX,
} from "./config";
import { countActiveConnections, revokeConnectionInTx } from "./connections";
import { OAuthError } from "./errors";
import {
  ACCESS_TOKEN_PREFIX,
  AUTHORIZATION_CODE_PREFIX,
  CODE_VERIFIER,
  MAX_SECRET_LENGTH,
  REFRESH_TOKEN_PREFIX,
  hashSecret,
  newAccessToken,
  newRefreshToken,
  verifyPkce,
} from "./secrets";
import { isMcpResource, mcpResourceOf } from "./urls";

/**
 * The token endpoint (RFC 6749 section 3.2, OAuth 2.1): the authorization code
 * and refresh token grants of public clients. Every outcome that must persist
 * (a burned code, a revoked connection) is written inside the transaction and
 * returned as a value; the error is raised after the commit.
 */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const field = (max: number) => z.string().min(1).max(max);

export const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: field(MAX_SECRET_LENGTH),
    redirect_uri: field(512),
    code_verifier: field(128),
    client_id: field(128),
    resource: field(RESOURCE_PARAM_MAX).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: field(MAX_SECRET_LENGTH),
    client_id: field(128),
    scope: field(SCOPE_PARAM_MAX).optional(),
    resource: field(RESOURCE_PARAM_MAX).optional(),
  }),
]);
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: OAuthError };

const refuse = (
  error: string,
  description: string,
  status = 400,
): { ok: false; error: OAuthError } => ({
  ok: false,
  error: new OAuthError(error, description, status),
});

const invalidGrant = (what: string) => refuse("invalid_grant", what);

const TX_LOCK = "oauth-grants";

type Tx = Parameters<Parameters<typeof transaction>[0]>[0];

/** Issues the access and refresh token of a connection; neither outlives the connection. */
async function issueTokens(
  tx: Tx,
  connection: { id: string; scopes: ApiScope[]; expiresAt: Date | null },
  now: number,
): Promise<TokenResponse> {
  const cap = connection.expiresAt?.getTime() ?? Infinity;
  const accessExpires = Math.min(now + ACCESS_TOKEN_TTL_MS, cap);
  const refreshExpires = Math.min(now + REFRESH_TOKEN_TTL_MS, cap);
  const access = newAccessToken();
  const refresh = newRefreshToken();
  await tx.insert(oauthTokens).values([
    {
      connectionId: connection.id,
      kind: "access",
      tokenHash: hashSecret(access),
      expiresAt: new Date(accessExpires),
    },
    {
      connectionId: connection.id,
      kind: "refresh",
      tokenHash: hashSecret(refresh),
      expiresAt: new Date(refreshExpires),
    },
  ]);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((accessExpires - now) / 1000)),
    refresh_token: refresh,
    scope: connection.scopes.join(" "),
  };
}

async function unwrap<T>(outcome: Promise<Outcome<T>>): Promise<T> {
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

export async function exchangeAuthorizationCode(
  input: Extract<TokenRequest, { grant_type: "authorization_code" }>,
  requestUrl: URL,
  now: number = Date.now(),
): Promise<TokenResponse> {
  if (!CODE_VERIFIER.test(input.code_verifier)) {
    throw new OAuthError(
      "invalid_request",
      "The code_verifier must be 43 to 128 characters of A-Z a-z 0-9 - . _ ~.",
    );
  }
  const client = await getClient(input.client_id);
  if (!client) {
    throw new OAuthError("invalid_client", "Unknown client.", 401);
  }
  if (!input.code.startsWith(AUTHORIZATION_CODE_PREFIX)) {
    throw new OAuthError(
      "invalid_grant",
      "The authorization code is invalid or expired.",
    );
  }
  const codeHash = hashSecret(input.code);
  return await unwrap(
    transaction(
      async (tx): Promise<Outcome<TokenResponse>> => {
        const row = await first(
          tx
            .select()
            .from(oauthAuthorizations)
            .where(eq(oauthAuthorizations.codeHash, codeHash)),
        );
        const gone = "The authorization code is invalid or expired.";
        if (!row) return invalidGrant(gone);
        if (row.usedAt !== null) {
          // A code is redeemed once. A second use means it leaked: what the
          // first use issued is revoked.
          if (row.connectionId) {
            await revokeConnectionInTx(
              tx,
              row.connectionId,
              now,
              row.connectionId,
            );
          }
          return invalidGrant(gone);
        }
        const burn = async () => {
          await tx
            .update(oauthAuthorizations)
            .set({ usedAt: new Date(now) })
            .where(
              and(
                eq(oauthAuthorizations.id, row.id),
                isNull(oauthAuthorizations.usedAt),
              ),
            );
        };
        // Any mismatch burns the code: whoever holds it is not the client
        // it was issued to, or is guessing.
        if (
          row.expiresAt.getTime() <= now ||
          row.clientId !== client.id ||
          row.redirectUri !== input.redirect_uri ||
          !verifyPkce(input.code_verifier, row.codeChallenge) ||
          row.scopes === null
        ) {
          await burn();
          return invalidGrant(gone);
        }
        if (
          row.resource !== mcpResourceOf(requestUrl) ||
          (input.resource !== undefined &&
            !isMcpResource(input.resource, requestUrl))
        ) {
          await burn();
          return refuse(
            "invalid_target",
            "The resource is not this server's MCP endpoint.",
          );
        }
        if (
          row.connectionExpiresAt !== null &&
          row.connectionExpiresAt.getTime() <= now
        ) {
          await burn();
          return invalidGrant("The connection's expiry has passed.");
        }
        const claimed = await tx
          .update(oauthAuthorizations)
          .set({ usedAt: new Date(now) })
          .where(
            and(
              eq(oauthAuthorizations.id, row.id),
              isNull(oauthAuthorizations.usedAt),
            ),
          )
          .returning({ id: oauthAuthorizations.id });
        if (claimed.length === 0) {
          // Redeemed concurrently: the winner's connection is revoked.
          const winner = await first(
            tx
              .select({ connectionId: oauthAuthorizations.connectionId })
              .from(oauthAuthorizations)
              .where(eq(oauthAuthorizations.id, row.id)),
          );
          if (winner?.connectionId) {
            await revokeConnectionInTx(
              tx,
              winner.connectionId,
              now,
              winner.connectionId,
            );
          }
          return invalidGrant(gone);
        }
        if (
          (await countActiveConnections(tx, row.userId, now)) >=
          MAX_ACTIVE_CONNECTIONS
        ) {
          return invalidGrant(
            "The owner has too many connected apps. Revoke one first.",
          );
        }
        const connection = (await first(
          tx
            .insert(mcpConnections)
            .values({
              userId: row.userId,
              clientId: client.id,
              name: client.name,
              scopes: row.scopes,
              categoryIds: row.categoryIds,
              accountIds: row.accountIds,
              resource: row.resource,
              expiresAt: row.connectionExpiresAt,
            })
            .returning(),
        ))!;
        await tx
          .update(oauthAuthorizations)
          .set({ connectionId: connection.id })
          .where(eq(oauthAuthorizations.id, row.id));
        await logAuthEventInTx(tx, "mcp_connection_granted", row.userId);
        return { ok: true, value: await issueTokens(tx, connection, now) };
      },
      { lock: TX_LOCK },
    ),
  );
}

export async function refreshTokens(
  input: Extract<TokenRequest, { grant_type: "refresh_token" }>,
  requestUrl: URL,
  now: number = Date.now(),
): Promise<TokenResponse> {
  const client = await getClient(input.client_id);
  if (!client) {
    throw new OAuthError("invalid_client", "Unknown client.", 401);
  }
  if (!input.refresh_token.startsWith(REFRESH_TOKEN_PREFIX)) {
    throw new OAuthError("invalid_grant", "The refresh token is invalid.");
  }
  const tokenHash = hashSecret(input.refresh_token);
  return await unwrap(
    transaction(
      async (tx): Promise<Outcome<TokenResponse>> => {
        const row = await first(
          tx
            .select({
              tokenId: oauthTokens.id,
              usedAt: oauthTokens.usedAt,
              tokenExpiresAt: oauthTokens.expiresAt,
              connection: mcpConnections,
            })
            .from(oauthTokens)
            .innerJoin(
              mcpConnections,
              eq(mcpConnections.id, oauthTokens.connectionId),
            )
            .where(
              and(
                eq(oauthTokens.tokenHash, tokenHash),
                eq(oauthTokens.kind, "refresh"),
              ),
            ),
        );
        const bad = "The refresh token is invalid or expired.";
        if (!row) return invalidGrant(bad);
        const { connection } = row;
        if (connection.revokedAt !== null) return invalidGrant(bad);
        if (row.usedAt !== null) {
          // A rotated token comes back: either the client or a thief holds a
          // copy, and which one cannot be told. The connection ends.
          await revokeConnectionInTx(tx, connection.id, now, connection.id);
          return invalidGrant(bad);
        }
        if (
          row.tokenExpiresAt.getTime() <= now ||
          (connection.expiresAt !== null &&
            connection.expiresAt.getTime() <= now)
        ) {
          return invalidGrant(bad);
        }
        if (connection.clientId !== client.id) return invalidGrant(bad);
        if (
          connection.resource !== mcpResourceOf(requestUrl) ||
          (input.resource !== undefined &&
            !isMcpResource(input.resource, requestUrl))
        ) {
          return refuse(
            "invalid_target",
            "The resource is not this server's MCP endpoint.",
          );
        }
        if (input.scope !== undefined) {
          // A refresh never widens the grant; the token's power is the
          // connection's, so a narrower request is not honoured either.
          const known = new Set<string>(API_SCOPES);
          const granted = new Set<string>(connection.scopes);
          const asked = input.scope.split(/\s+/).filter((s) => known.has(s));
          if (asked.some((s) => !granted.has(s))) {
            return refuse(
              "invalid_scope",
              "The scope is wider than what the owner granted.",
            );
          }
        }
        const claimed = await tx
          .update(oauthTokens)
          .set({ usedAt: new Date(now) })
          .where(
            and(eq(oauthTokens.id, row.tokenId), isNull(oauthTokens.usedAt)),
          )
          .returning({ id: oauthTokens.id });
        if (claimed.length === 0) {
          await revokeConnectionInTx(tx, connection.id, now, connection.id);
          return invalidGrant(bad);
        }
        return { ok: true, value: await issueTokens(tx, connection, now) };
      },
      { lock: TX_LOCK },
    ),
  );
}

export const revocationSchema = z.object({
  token: field(MAX_SECRET_LENGTH),
  client_id: field(128),
  token_type_hint: z.string().max(32).optional(),
});

/**
 * RFC 7009: the token (access or refresh) ends its connection, so nothing the
 * connection issued keeps working. An unknown or foreign token is not an error
 * and not an oracle: the answer is the same.
 */
export async function revokeToken(
  input: z.infer<typeof revocationSchema>,
  now: number = Date.now(),
): Promise<void> {
  if (
    !input.token.startsWith(ACCESS_TOKEN_PREFIX) &&
    !input.token.startsWith(REFRESH_TOKEN_PREFIX)
  ) {
    return;
  }
  const tokenHash = hashSecret(input.token);
  await transaction(
    async (tx) => {
      const row = await first(
        tx
          .select({
            connectionId: mcpConnections.id,
            clientId: mcpConnections.clientId,
          })
          .from(oauthTokens)
          .innerJoin(
            mcpConnections,
            eq(mcpConnections.id, oauthTokens.connectionId),
          )
          .where(eq(oauthTokens.tokenHash, tokenHash)),
      );
      if (!row || row.clientId !== input.client_id) return;
      await revokeConnectionInTx(tx, row.connectionId, now, row.connectionId);
    },
    { lock: TX_LOCK },
  );
}
