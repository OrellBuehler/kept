import { afterEach, describe, expect, it } from "vitest";
import {
  getDB,
  mcpConnections,
  oauthAuthorizations,
  oauthClients,
  oauthTokens,
} from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  authorizeLoad,
  authorizeQuery,
  connect,
  pkce,
  registerTestClient,
} from "$lib/testing/oauth";
import {
  AUTHORIZATION_RETENTION_MS,
  DEAD_CONNECTION_RETENTION_MS,
  EXPIRED_TOKEN_RETENTION_MS,
  PENDING_REQUEST_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  UNUSED_CLIENT_TTL_MS,
} from "./config";
import { registrationLimiter, tokenFailureLimiter } from "./http";
import { revokeConnection } from "./connections";
import {
  registerOAuthSweep,
  sweepOAuth,
  unregisterOAuthSweep,
} from "./maintenance";

useTestDB();

afterEach(() => {
  registrationLimiter.reset();
  tokenFailureLimiter.reset();
  unregisterOAuthSweep();
});

const count = async (
  table:
    | typeof mcpConnections
    | typeof oauthTokens
    | typeof oauthAuthorizations
    | typeof oauthClients,
) => (await getDB().select().from(table)).length;

describe("the OAuth sweep", () => {
  it("leaves a live connection and its tokens alone", async () => {
    const user = await createTestUser();
    await connect(user);
    await sweepOAuth(Date.now() + 60_000);
    expect(await count(mcpConnections)).toBe(1);
    expect(await count(oauthTokens)).toBe(2);
    expect(
      (await getDB().select().from(mcpConnections))[0]!.expiresAt,
    ).toBeNull();
  });

  it("drops expired tokens after their retention, and marks an unrenewable connection expired", async () => {
    const user = await createTestUser();
    await connect(user);
    const afterRefresh = Date.now() + REFRESH_TOKEN_TTL_MS + 60_000;
    await sweepOAuth(afterRefresh);
    expect(
      (await getDB().select().from(mcpConnections))[0]!.expiresAt,
    ).not.toBeNull();
    // The access token lapsed long before its retention; the refresh token only just.
    expect(await count(oauthTokens)).toBe(1);
    await sweepOAuth(afterRefresh + EXPIRED_TOKEN_RETENTION_MS + 60_000);
    expect(await count(oauthTokens)).toBe(0);
  });

  it("removes connections that ended long ago, with their tokens, and keeps recent ones", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    await revokeConnection(user.id, c.connectionId);
    await sweepOAuth(Date.now() + DEAD_CONNECTION_RETENTION_MS - 60_000);
    expect(await count(mcpConnections)).toBe(1);
    await sweepOAuth(Date.now() + DEAD_CONNECTION_RETENTION_MS + 60_000);
    expect(await count(mcpConnections)).toBe(0);
    expect(await count(oauthTokens)).toBe(0);
  });

  it("removes stale requests and spent codes, and keeps a pending one for its life", async () => {
    const user = await createTestUser();
    await connect(user);
    const { clientId } = await registerTestClient();
    await authorizeLoad(
      user,
      authorizeQuery({ clientId, challenge: pkce().challenge }),
    );
    expect(await count(oauthAuthorizations)).toBe(2);
    await sweepOAuth(Date.now() + PENDING_REQUEST_TTL_MS - 60_000);
    expect(await count(oauthAuthorizations)).toBe(2);
    await sweepOAuth(
      Date.now() + AUTHORIZATION_RETENTION_MS + PENDING_REQUEST_TTL_MS + 60_000,
    );
    expect(await count(oauthAuthorizations)).toBe(0);
  });

  it("drops clients nobody connected through", async () => {
    const user = await createTestUser();
    await connect(user);
    await registerTestClient();
    expect(await count(oauthClients)).toBe(2);
    await sweepOAuth(Date.now() + UNUSED_CLIENT_TTL_MS + 60_000);
    expect(await count(oauthClients)).toBe(1);
  });

  it("runs on a ticker that can be stopped", async () => {
    const user = await createTestUser();
    await registerTestClient();
    expect(await count(oauthClients)).toBe(1);
    registerOAuthSweep({ intervalMs: 3_600_000, firstRunDelayMs: 1_000_000 });
    registerOAuthSweep();
    unregisterOAuthSweep();
    expect(user.id).toBeTruthy();
  });
});
