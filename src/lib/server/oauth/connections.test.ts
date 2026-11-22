import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { changePassword, deleteUser } from "$lib/server/auth/users";
import { authEvents, getDB, mcpConnections, oauthTokens } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { connect, oauthCall, pkce } from "$lib/testing/oauth";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "./config";
import {
  CONNECTION_LAST_USED_THROTTLE_MS,
  listConnections,
  renameConnection,
  revokeConnection,
  verifyAccessToken,
} from "./connections";
import { registrationLimiter, tokenFailureLimiter } from "./http";

useTestDB();

afterEach(() => {
  registrationLimiter.reset();
  tokenFailureLimiter.reset();
});

const URL_MCP = new URL("http://localhost/api/mcp");

describe("verifying an access token", () => {
  it("resolves to the connection's identity and consent", async () => {
    const user = await createTestUser();
    const c = await connect(user, { scopes: ["bills:read"] });
    const result = await verifyAccessToken(c.accessToken, URL_MCP);
    expect(result).toEqual({
      ok: true,
      token: {
        id: c.connectionId,
        userId: user.id,
        name: "Test Client",
        scopes: ["bills:read"],
        categoryIds: null,
        accountIds: null,
      },
    });
  });

  it("refuses what is not an access token of this server", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    for (const presented of [
      "",
      "keptat_",
      "keptat_" + "x".repeat(43),
      c.refreshToken,
      "kept_" + "x".repeat(43),
      "keptat_" + "x".repeat(500),
    ]) {
      expect(
        await verifyAccessToken(presented, URL_MCP),
        presented.slice(0, 12),
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses an expired token, an expired connection and a revoked one", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    expect(
      await verifyAccessToken(
        c.accessToken,
        URL_MCP,
        Date.now() + ACCESS_TOKEN_TTL_MS + 1000,
      ),
    ).toEqual({ ok: false, reason: "expired" });
    await getDB()
      .update(mcpConnections)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyAccessToken(c.accessToken, URL_MCP)).toEqual({
      ok: false,
      reason: "expired",
    });
    await getDB()
      .update(mcpConnections)
      .set({ expiresAt: null, revokedAt: new Date() });
    expect(await verifyAccessToken(c.accessToken, URL_MCP)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("refuses a token issued for another resource", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    // The same token presented at another address of the server, or after the address changed.
    expect(
      await verifyAccessToken(
        c.accessToken,
        new URL("http://other.test/api/mcp"),
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    await getDB()
      .update(mcpConnections)
      .set({ resource: "https://elsewhere.example.org/api/mcp" });
    expect(await verifyAccessToken(c.accessToken, URL_MCP)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refreshes lastUsedAt at most once a minute", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    const read = async () =>
      (
        await getDB()
          .select()
          .from(mcpConnections)
          .where(eq(mcpConnections.id, c.connectionId))
      )[0]!.lastUsedAt;
    expect(await read()).toBeNull();
    const t0 = Date.now();
    await verifyAccessToken(c.accessToken, URL_MCP, t0);
    expect((await read())!.getTime()).toBe(t0);
    await verifyAccessToken(c.accessToken, URL_MCP, t0 + 1000);
    expect((await read())!.getTime()).toBe(t0);
    const later = t0 + CONNECTION_LAST_USED_THROTTLE_MS + 1;
    await verifyAccessToken(c.accessToken, URL_MCP, later);
    expect((await read())!.getTime()).toBe(later);
  });

  it("stops working when the connection is revoked, not just when the token expires", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    await revokeConnection(user.id, c.connectionId);
    expect(await verifyAccessToken(c.accessToken, URL_MCP)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });
});

describe("managing connections", () => {
  it("lists only the user's own, with what the owner granted", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await connect(a, { scopes: ["bills:read"], name: "Mine" });
    await connect(b, { scopes: ["transactions:read"], name: "Theirs" });
    const mine = await listConnections(a.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      name: "Mine",
      clientName: "Mine",
      scopes: ["bills:read"],
      categoryIds: null,
      accountIds: null,
      revokedAt: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(JSON.stringify(mine)).not.toContain("keptat_");
    expect(JSON.stringify(mine)).not.toContain("Theirs");
  });

  it("revokes at once, idempotently, and never another user's connection", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const c = await connect(a);
    await expect(revokeConnection(b.id, c.connectionId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await listConnections(a.id))[0]!.revokedAt).toBeNull();

    await revokeConnection(a.id, c.connectionId);
    await revokeConnection(a.id, c.connectionId);
    expect((await listConnections(a.id))[0]!.revokedAt).not.toBeNull();
    const events = (await getDB().select().from(authEvents)).filter(
      (e) => e.type === "mcp_connection_revoked",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: a.id, actorId: a.id });
    // Its refresh token is dead too.
    const res = await oauthCall("/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: c.refreshToken,
        client_id: c.clientId,
      },
    });
    expect(res.status).toBe(400);
  });

  it("renames for the owner only, with a bounded name", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const c = await connect(a);
    await renameConnection(a.id, c.connectionId, "  Laptop  ");
    expect((await listConnections(a.id))[0]!.name).toBe("Laptop");
    await expect(
      renameConnection(b.id, c.connectionId, "Hijacked"),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const name of ["", "   ", "x".repeat(65)]) {
      await expect(
        renameConnection(a.id, c.connectionId, name),
      ).rejects.toBeInstanceOf(LedgerError);
    }
    expect((await listConnections(a.id))[0]!.name).toBe("Laptop");
    // The renamed connection shows its new name to the gate.
    const verified = await verifyAccessToken(c.accessToken, URL_MCP);
    expect(verified).toMatchObject({ ok: true, token: { name: "Laptop" } });
  });
});

describe("what ends a connection", () => {
  it("is deleted with its owner: tokens and all", async () => {
    const admin = await createTestUser({ role: "admin" });
    const user = await createTestUser();
    const c = await connect(user);
    await deleteUser(admin.id, user.id);
    expect(await getDB().select().from(mcpConnections)).toHaveLength(0);
    expect(await getDB().select().from(oauthTokens)).toHaveLength(0);
    expect(await verifyAccessToken(c.accessToken, URL_MCP)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("survives a password change, like an API token, until the owner revokes it", async () => {
    const user = await createTestUser();
    const c = await connect(user);
    await changePassword(user.id, user.password, "a-new-long-password");
    expect(await verifyAccessToken(c.accessToken, URL_MCP)).toMatchObject({
      ok: true,
    });
    const res = await oauthCall("/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: c.refreshToken,
        client_id: c.clientId,
      },
    });
    expect(res.status).toBe(200);
  });

  it("goes quiet when nothing it holds can be used any more", async () => {
    const { sweepOAuth } = await import("./maintenance");
    const user = await createTestUser();
    const c = await connect(user);
    await sweepOAuth(Date.now() + 1000);
    expect((await listConnections(user.id))[0]!.expiresAt).toBeNull();
    // Past the refresh token's life nothing can renew it: it is shown as expired.
    const later = Date.now() + REFRESH_TOKEN_TTL_MS + 60_000;
    await sweepOAuth(later);
    const [row] = await listConnections(user.id);
    expect(row!.expiresAt).not.toBeNull();
    expect(row!.revokedAt).toBeNull();
    expect(c.connectionId).toBe(row!.id);
  });
});

describe("a fresh PKCE pair", () => {
  it("is unrelated each time", () => {
    expect(pkce().verifier).not.toBe(pkce().verifier);
  });
});
