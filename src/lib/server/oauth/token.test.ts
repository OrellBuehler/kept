import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authEvents,
  getDB,
  mcpConnections,
  oauthAuthorizations,
  oauthTokens,
} from "$lib/server/db";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  BASE,
  LOOPBACK,
  authorizeLoad,
  authorizeQuery,
  body,
  consentAction,
  oauthCall,
  parseRedirect,
  pkce,
  registerTestClient,
} from "$lib/testing/oauth";
import {
  ACCESS_TOKEN_TTL_MS,
  CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from "./config";
import { verifyAccessToken } from "./connections";
import { tokenFailureLimiter } from "./http";
import { hashSecret } from "./secrets";
import {
  exchangeAuthorizationCode,
  refreshTokens,
  revokeToken,
  type TokenResponse,
} from "./token";

useTestDB();

afterEach(() => tokenFailureLimiter.reset());

interface Issued {
  clientId: string;
  code: string;
  verifier: string;
}

/** A client, a request and an approval: the authorization code, not yet redeemed. */
async function issue(
  user: TestUser,
  over: {
    clientId?: string;
    scopes?: string[];
    expires?: string;
    redirectUri?: string;
  } = {},
): Promise<Issued> {
  const clientId = over.clientId ?? (await registerTestClient()).clientId;
  const { verifier, challenge } = pkce();
  const begun = await authorizeLoad(
    user,
    authorizeQuery({
      clientId,
      challenge,
      redirectUri: over.redirectUri ?? LOOPBACK,
    }),
  );
  const consent = new URL(
    (begun as { location: string }).location,
    BASE,
  ).searchParams.get("consent")!;
  const approved = await consentAction("approve", user, consent, {
    scope: over.scopes ?? ["bills:read", "transactions:read"],
    ...(over.expires ? { expires: over.expires } : {}),
  });
  const { redirectTo } = (approved as { value: { redirectTo: string } }).value;
  return {
    clientId,
    verifier,
    code: parseRedirect(redirectTo).searchParams.get("code")!,
  };
}

const codeForm = (i: Issued, over: Record<string, string> = {}) => ({
  grant_type: "authorization_code",
  code: i.code,
  redirect_uri: LOOPBACK,
  client_id: i.clientId,
  code_verifier: i.verifier,
  ...over,
});

const post = (form: Record<string, string>, ip?: string) =>
  oauthCall("/oauth/token", { form, ip });

async function redeem(i: Issued): Promise<TokenResponse> {
  const res = await post(codeForm(i));
  expect(res.status).toBe(200);
  return await body<TokenResponse>(res);
}

const refreshForm = (
  clientId: string,
  refresh: string,
  over: Record<string, string> = {},
) => ({
  grant_type: "refresh_token",
  refresh_token: refresh,
  client_id: clientId,
  ...over,
});

async function connectionRows() {
  return await getDB().select().from(mcpConnections);
}

describe("authorization code grant", () => {
  it("issues an access token, a refresh token and the granted scope", async () => {
    const user = await createTestUser();
    const tokens = await redeem(await issue(user));
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: "bills:read transactions:read",
    });
    expect(tokens.access_token).toMatch(/^keptat_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^keptrt_[A-Za-z0-9_-]{43}$/);
    const [conn] = await connectionRows();
    expect(conn).toMatchObject({
      userId: user.id,
      name: "Test Client",
      scopes: ["bills:read", "transactions:read"],
      resource: `${BASE}/api/mcp`,
      revokedAt: null,
    });
  });

  it("stores only hashes of what it issued", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const tokens = await redeem(issued);
    const stored = JSON.stringify([
      await getDB().select().from(oauthTokens),
      await getDB().select().from(oauthAuthorizations),
    ]);
    for (const secret of [
      tokens.access_token,
      tokens.refresh_token,
      issued.code,
      issued.verifier,
    ]) {
      expect(stored).not.toContain(secret);
    }
    const rows = await getDB().select().from(oauthTokens);
    expect(rows.map((r) => r.tokenHash).sort()).toEqual(
      [
        hashSecret(tokens.access_token),
        hashSecret(tokens.refresh_token),
      ].sort(),
    );
  });

  it("refuses a wrong PKCE verifier and burns the code", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const res = await post(
      codeForm(issued, { code_verifier: pkce().verifier }),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("invalid_grant");
    // The right verifier no longer helps: whoever guessed has spent the code.
    expect((await post(codeForm(issued))).status).toBe(400);
    expect(await connectionRows()).toHaveLength(0);
  });

  it("refuses a malformed verifier without touching the code", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const res = await post(codeForm(issued, { code_verifier: "short" }));
    expect((await body(res)).error).toBe("invalid_request");
    expect((await post(codeForm(issued))).status).toBe(200);
  });

  it("refuses a code presented by another client", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const other = (await registerTestClient()).clientId;
    const res = await post(codeForm(issued, { client_id: other }));
    expect((await body(res)).error).toBe("invalid_grant");
    expect((await post(codeForm(issued))).status).toBe(400);
  });

  it("refuses an unknown client", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const res = await post(codeForm(issued, { client_id: "nope" }));
    expect(res.status).toBe(401);
    expect((await body(res)).error).toBe("invalid_client");
  });

  it("refuses another redirect URI than the request named, even a matching loopback port", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    for (const redirect_uri of [
      "http://127.0.0.1:60000/callback",
      "https://evil.example.org/callback",
    ]) {
      const fresh = await issue(user, { clientId: issued.clientId });
      const res = await post(codeForm(fresh, { redirect_uri }));
      expect((await body(res)).error, redirect_uri).toBe("invalid_grant");
    }
  });

  it("refuses a code issued for another resource, or a request naming one", async () => {
    const user = await createTestUser();
    const named = await issue(user);
    const res = await post(
      codeForm(named, { resource: "https://evil.example.org/api/mcp" }),
    );
    expect((await body(res)).error).toBe("invalid_target");
    // The same code issued under another server address cannot be redeemed here.
    const other = await issue(user);
    await getDB()
      .update(oauthAuthorizations)
      .set({ resource: "https://elsewhere.example.org/api/mcp" })
      .where(eq(oauthAuthorizations.codeHash, hashSecret(other.code)));
    expect((await body(await post(codeForm(other)))).error).toBe(
      "invalid_target",
    );
    const ok = await issue(user);
    expect(
      (await post(codeForm(ok, { resource: `${BASE}/api/mcp` }))).status,
    ).toBe(200);
  });

  it("refuses an expired code", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const { code_verifier, redirect_uri, client_id, code } = codeForm(issued);
    await expect(
      exchangeAuthorizationCode(
        {
          grant_type: "authorization_code",
          code,
          code_verifier,
          redirect_uri,
          client_id,
        },
        new URL(`${BASE}/oauth/token`),
        Date.now() + CODE_TTL_MS + 1000,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("revokes what the first redemption issued when the code is used a second time", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const first = await redeem(issued);
    expect((await post(codeForm(issued))).status).toBe(400);
    const [conn] = await connectionRows();
    expect(conn!.revokedAt).not.toBeNull();
    expect(
      await verifyAccessToken(first.access_token, new URL(`${BASE}/api/mcp`)),
    ).toEqual({ ok: false, reason: "revoked" });
    const refreshed = await post(
      refreshForm(issued.clientId, first.refresh_token),
    );
    expect(refreshed.status).toBe(400);
  });

  it("lets only one of two simultaneous redemptions through, and then revokes it", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const results = await Promise.all([
      post(codeForm(issued)),
      post(codeForm(issued)),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(
      1,
    );
    const [conn] = await connectionRows();
    expect(conn!.revokedAt).not.toBeNull();
  });

  it("ends a connection at its expiry: the tokens never outlive it", async () => {
    const user = await createTestUser();
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const tokens = await redeem(await issue(user, { expires: tomorrow }));
    const [conn] = await connectionRows();
    expect(conn!.expiresAt).not.toBeNull();
    const remaining = (conn!.expiresAt!.getTime() - Date.now()) / 1000;
    expect(tokens.expires_in).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS / 1000);
    for (const row of await getDB().select().from(oauthTokens)) {
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
        conn!.expiresAt!.getTime(),
      );
    }
    expect(remaining).toBeGreaterThan(0);
  });

  it("records the grant in the security log", async () => {
    const user = await createTestUser();
    await redeem(await issue(user));
    const events = await getDB().select().from(authEvents);
    expect(events.map((e) => [e.type, e.userId])).toContainEqual([
      "mcp_connection_granted",
      user.id,
    ]);
  });
});

describe("refresh token grant", () => {
  async function connected() {
    const user = await createTestUser();
    const issued = await issue(user);
    return { user, issued, tokens: await redeem(issued) };
  }

  it("rotates: a new pair, the same connection, the same scope", async () => {
    const { issued, tokens } = await connected();
    const res = await post(refreshForm(issued.clientId, tokens.refresh_token));
    expect(res.status).toBe(200);
    const next = await body<TokenResponse>(res);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.scope).toBe(tokens.scope);
    expect(await connectionRows()).toHaveLength(1);
  });

  it("revokes the connection when a rotated refresh token is presented again", async () => {
    const { issued, tokens } = await connected();
    const next = await body<TokenResponse>(
      await post(refreshForm(issued.clientId, tokens.refresh_token)),
    );
    const reuse = await post(
      refreshForm(issued.clientId, tokens.refresh_token),
    );
    expect(reuse.status).toBe(400);
    expect((await body(reuse)).error).toBe("invalid_grant");
    const [conn] = await connectionRows();
    expect(conn!.revokedAt).not.toBeNull();
    // The thief's copy and the client's newer copy are both dead.
    expect(
      (await post(refreshForm(issued.clientId, next.refresh_token))).status,
    ).toBe(400);
    const events = await getDB().select().from(authEvents);
    expect(events.map((e) => e.type)).toContain("mcp_connection_revoked");
  });

  it("never widens the grant, whatever scope the request asks for", async () => {
    const { issued, tokens } = await connected();
    for (const scope of [
      "bills:write",
      "bills:read bills:write",
      "links:write",
    ]) {
      const res = await post(
        refreshForm(issued.clientId, tokens.refresh_token, { scope }),
      );
      expect(res.status, scope).toBe(400);
      expect((await body(res)).error, scope).toBe("invalid_scope");
    }
    // None of those attempts used the token up.
    const res = await post(
      refreshForm(issued.clientId, tokens.refresh_token, {
        scope: "bills:read",
      }),
    );
    expect(res.status).toBe(200);
    // What it returns is still the consent, not the narrower request.
    expect((await body(res)).scope).toBe("bills:read transactions:read");
  });

  it("ignores scope names it does not know instead of refusing", async () => {
    const { issued, tokens } = await connected();
    const res = await post(
      refreshForm(issued.clientId, tokens.refresh_token, {
        scope: "bills:read offline_access",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("refuses another client's use of the token, an unknown token and an access token", async () => {
    const { issued, tokens } = await connected();
    const other = (await registerTestClient()).clientId;
    for (const form of [
      refreshForm(other, tokens.refresh_token),
      refreshForm(issued.clientId, "keptrt_" + "x".repeat(43)),
      refreshForm(issued.clientId, tokens.access_token),
      refreshForm(issued.clientId, "kept_" + "x".repeat(43)),
    ]) {
      expect((await post(form)).status).toBe(400);
    }
    expect(
      (await post(refreshForm(issued.clientId, tokens.refresh_token))).status,
    ).toBe(200);
  });

  it("refuses an expired refresh token and a connection past its expiry", async () => {
    const { issued, tokens } = await connected();
    const input = {
      grant_type: "refresh_token" as const,
      refresh_token: tokens.refresh_token,
      client_id: issued.clientId,
    };
    await expect(
      refreshTokens(
        input,
        new URL(`${BASE}/oauth/token`),
        Date.now() + REFRESH_TOKEN_TTL_MS + 1000,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    await getDB()
      .update(mcpConnections)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect(
      (await post(refreshForm(issued.clientId, tokens.refresh_token))).status,
    ).toBe(400);
  });

  it("refuses a revoked connection and does not bring it back", async () => {
    const { issued, tokens } = await connected();
    await getDB().update(mcpConnections).set({ revokedAt: new Date() });
    expect(
      (await post(refreshForm(issued.clientId, tokens.refresh_token))).status,
    ).toBe(400);
  });

  it("refuses a resource that is not the MCP endpoint", async () => {
    const { issued, tokens } = await connected();
    const res = await post(
      refreshForm(issued.clientId, tokens.refresh_token, {
        resource: "https://evil.example.org/api/mcp",
      }),
    );
    expect((await body(res)).error).toBe("invalid_target");
  });

  it("lets only one of two simultaneous refreshes through", async () => {
    const { issued, tokens } = await connected();
    const results = await Promise.all([
      post(refreshForm(issued.clientId, tokens.refresh_token)),
      post(refreshForm(issued.clientId, tokens.refresh_token)),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });
});

describe("revocation", () => {
  it("ends the connection by its access token or its refresh token", async () => {
    for (const kind of ["access_token", "refresh_token"] as const) {
      const user = await createTestUser();
      const issued = await issue(user);
      const tokens = await redeem(issued);
      const res = await oauthCall("/oauth/revoke", {
        form: { token: tokens[kind], client_id: issued.clientId },
      });
      expect(res.status).toBe(200);
      const rows = await getDB()
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.userId, user.id));
      expect(rows[0]!.revokedAt, kind).not.toBeNull();
      expect(
        (await post(refreshForm(issued.clientId, tokens.refresh_token))).status,
      ).toBe(400);
    }
  });

  it("answers the same for an unknown token and ignores another client's request", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const tokens = await redeem(issued);
    const other = (await registerTestClient()).clientId;
    const answers = [];
    for (const form of [
      { token: "keptat_" + "y".repeat(43), client_id: issued.clientId },
      { token: "whatever", client_id: issued.clientId },
      { token: tokens.refresh_token, client_id: other },
      { token: tokens.refresh_token, client_id: "unknown" },
    ]) {
      const res = await oauthCall("/oauth/revoke", { form });
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect((await connectionRows())[0]!.revokedAt).toBeNull();
  });

  it("is idempotent", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    const tokens = await redeem(issued);
    await revokeToken({
      token: tokens.refresh_token,
      client_id: issued.clientId,
    });
    await revokeToken({
      token: tokens.refresh_token,
      client_id: issued.clientId,
    });
    const events = await getDB().select().from(authEvents);
    expect(
      events.filter((e) => e.type === "mcp_connection_revoked"),
    ).toHaveLength(1);
  });
});

describe("secrets stay out of logs", () => {
  it("never logs a code, a token or a verifier through the whole flow", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const user = await createTestUser();
      const issued = await issue(user);
      const tokens = await redeem(issued);
      await post(codeForm(issued));
      await post(refreshForm(issued.clientId, tokens.refresh_token));
      await oauthCall("/oauth/revoke", {
        form: { token: tokens.access_token, client_id: issued.clientId },
      });
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((args) => args.map(String).join(" "))
        .join("\n");
      for (const secret of [
        issued.code,
        issued.verifier,
        tokens.access_token,
        tokens.refresh_token,
      ]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("the token endpoint refuses an address that keeps failing", () => {
  it("answers 429 after too many failures from one address, and only that address", async () => {
    const bad = {
      grant_type: "refresh_token",
      refresh_token: "keptrt_nope",
      client_id: "x",
    };
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await post(bad, "198.51.100.77")).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    const res = await post(bad, "198.51.100.77");
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await post(bad, "198.51.100.78")).status).not.toBe(429);
  });

  it("gives an attempt back when it succeeds", async () => {
    const user = await createTestUser();
    const issued = await issue(user);
    let refresh = (await redeem(issued)).refresh_token;
    for (let i = 0; i < 40; i++) {
      const res = await post(
        refreshForm(issued.clientId, refresh),
        "198.51.100.90",
      );
      expect(res.status).toBe(200);
      refresh = (await body<TokenResponse>(res)).refresh_token;
    }
  });
});

describe("whose data a connection reaches", () => {
  it("belongs to the user who consented, and only theirs", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await redeem(await issue(a));
    await redeem(await issue(b));
    const rows = await connectionRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([a.id, b.id].sort());
  });
});
