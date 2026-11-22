import { afterEach, describe, expect, it } from "vitest";
import {
  API_AUTH_FAILURES_PER_IP,
  apiAuthFailureLimiter,
} from "$lib/server/external-api/gate";
import { revokeConnection } from "$lib/server/oauth/connections";
import {
  registrationLimiter,
  tokenFailureLimiter,
} from "$lib/server/oauth/http";
import { SESSION_COOKIE } from "$lib/server/auth/sessions";
import { loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { callApi } from "$lib/testing/external-api";
import { createTestEvent } from "$lib/testing/event";
import {
  callMcp,
  callTool,
  initialize,
  listToolNames,
  rpc,
} from "$lib/testing/mcp";
import { buildWorld } from "$lib/testing/mcp-world";
import { connect } from "$lib/testing/oauth";
import { seedToken } from "$lib/testing/external-api";
import { handle } from "../../../hooks.server";
import { MCP_REQUESTS_PER_MINUTE, mcpTokenLimiter } from "./gate";

useTestDB();

afterEach(() => {
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
  registrationLimiter.reset();
  tokenFailureLimiter.reset();
});

describe("mcp gate: OAuth access tokens", () => {
  it("accepts an access token and gives it exactly the consented tools", async () => {
    const w = await buildWorld();
    const c = await connect(w.a, {
      scopes: ["bills:read", "transactions:read"],
    });
    expect((await initialize(c.accessToken)).status).toBe(200);
    const tools = await listToolNames(c.accessToken);
    expect(tools).toContain("list_bills");
    expect(tools).toContain("list_transactions");
    expect(tools).not.toContain("update_transaction");
    const who = await callTool(c.accessToken, "whoami");
    expect(who.data).toMatchObject({
      connection: {
        name: "Test Client",
        credential: "mcp_connection",
        scopes: ["bills:read", "transactions:read"],
      },
    });
  });

  it("keeps working next to API tokens, which are untouched", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    const { token } = await seedToken(w.a.id, ["bills:read"]);
    expect((await initialize(token)).status).toBe(200);
    expect((await initialize(c.accessToken)).status).toBe(200);
  });

  it("never reaches another user's data", async () => {
    const w = await buildWorld();
    const c = await connect(w.a, {
      scopes: ["transactions:read", "bills:read"],
    });
    const list = await callTool(c.accessToken, "list_transactions", {});
    const ids = (list.data.items as { id: string }[]).map((t) => t.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(w.bTx.id);
    expect(
      (
        await callTool(c.accessToken, "get_transaction", {
          paymentId: w.bTx.id,
        })
      ).isError,
    ).toBe(true);
    expect(
      (await callTool(c.accessToken, "get_bill", { billId: w.bBill.id }))
        .isError,
    ).toBe(true);
    const bills = await callTool(c.accessToken, "list_bills", {});
    expect(JSON.stringify(bills.data)).not.toContain(w.bBill.id);
    // B's own connection sees B's data and not A's.
    const other = await connect(w.b, { scopes: ["transactions:read"] });
    const theirs = await callTool(other.accessToken, "list_transactions", {});
    const theirIds = (theirs.data.items as { id: string }[]).map((t) => t.id);
    expect(theirIds).toEqual([w.bTx.id]);
  });

  it("applies the owner's account and category restrictions", async () => {
    const w = await buildWorld();
    const byAccount = await connect(w.a, {
      scopes: ["transactions:read"],
      accountIds: [w.savings.id],
    });
    const list = await callTool(byAccount.accessToken, "list_transactions", {});
    const ids = (list.data.items as { id: string }[]).map((t) => t.id).sort();
    expect(ids).toEqual([w.t3.id, w.t4.id].sort());
    const byCategory = await connect(w.a, {
      scopes: ["transactions:read"],
      categoryIds: [w.rent.id],
    });
    const rent = await callTool(
      byCategory.accessToken,
      "list_transactions",
      {},
    );
    expect((rent.data.items as { id: string }[]).map((t) => t.id)).toEqual([
      w.t2.id,
    ]);
  });

  it("refuses a write the consent did not include", async () => {
    const w = await buildWorld();
    const c = await connect(w.a, { scopes: ["transactions:read"] });
    const out = await callTool(c.accessToken, "update_transaction", {
      paymentId: w.t4.id,
      note: "nope",
    });
    expect(out.isError).toBe(true);
  });

  it("answers 401 with the metadata pointer, and names the problem when a token was refused", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    const missing = await callMcp(null, { body: {} });
    expect(missing.headers.get("www-authenticate")).not.toContain("error=");
    expect(missing.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/api/mcp"',
    );
    await revokeConnection(w.a.id, c.connectionId);
    for (const token of [c.accessToken, "keptat_" + "z".repeat(43)]) {
      const res = await callMcp(token, { body: {} });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
      expect(res.headers.get("www-authenticate")).toContain(
        "resource_metadata=",
      );
    }
  });

  it("refuses a token used under another server address (its audience)", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    const event = createTestEvent({
      url: "http://other.test/api/mcp",
      method: "POST",
      headers: {
        authorization: `Bearer ${c.accessToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const res = await handle({
      event: event as never,
      resolve: (async () => new Response("reached")) as never,
    });
    expect(res.status).toBe(401);
  });

  it("limits each connection's requests per minute, per connection", async () => {
    const w = await buildWorld();
    const busy = await connect(w.a);
    const quiet = await connect(w.a);
    for (let i = 0; i < MCP_REQUESTS_PER_MINUTE; i++) {
      mcpTokenLimiter.acquire(busy.connectionId, busy.connectionId);
    }
    const refused = await callMcp(busy.accessToken, {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await rpc(quiet.accessToken, "tools/list", {})).status).toBe(200);
  });

  it("counts refused access tokens per address, like refused API tokens, and shares the budget", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    const ip = "198.51.100.9";
    for (let i = 0; i < API_AUTH_FAILURES_PER_IP; i++) {
      const bad =
        i % 2 === 0 ? "keptat_" + "q".repeat(43) : "kept_" + "q".repeat(43);
      expect((await initialize(bad, { ip })).status).toBe(401);
    }
    expect((await initialize("keptat_" + "q".repeat(43), { ip })).status).toBe(
      429,
    );
    expect((await initialize(c.accessToken, { ip })).status).toBe(429);
    expect(
      (await initialize(c.accessToken, { ip: "198.51.100.10" })).status,
    ).toBe(200);
  });

  it("does not hold a revoked client's retries against its address", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    await revokeConnection(w.a.id, c.connectionId);
    const ip = "198.51.100.20";
    for (let i = 0; i < API_AUTH_FAILURES_PER_IP + 5; i++) {
      expect((await initialize(c.accessToken, { ip })).status).toBe(401);
    }
    const fresh = await connect(w.a);
    expect((await initialize(fresh.accessToken, { ip })).status).toBe(200);
  });

  it("ignores a session cookie, with or without a token", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    const { token } = await loginTestUser(w.a);
    const cookies = { [SESSION_COOKIE]: token };
    expect((await callMcp(null, { cookies, body: {} })).status).toBe(401);
    expect((await initialize(c.accessToken, { cookies })).status).toBe(200);
  });
});

describe("OAuth access tokens are valid at /api/mcp only", () => {
  it("are refused by the external API, whatever the path", async () => {
    const w = await buildWorld();
    const c = await connect(w.a, {
      scopes: ["bills:read", "accounts:read", "transactions:read"],
    });
    for (const path of [
      "/api/external/v1/me",
      "/api/external/v1/bills",
      "/api/external/v1/accounts",
      "/api/external/v1/transactions",
      "/api/external/v1/nothing-here",
    ]) {
      const res = await callApi(c.accessToken, path);
      expect(res.status, path).toBe(401);
    }
  });

  it("are refused by the mobile apps' API", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    for (const path of [
      "/api/app/v1/session",
      "/api/app/v1/reminders",
      "/api/app/v1/pages/bills",
    ]) {
      const event = createTestEvent({
        url: `http://localhost${path}`,
        headers: { authorization: `Bearer ${c.accessToken}` },
      });
      const res = await handle({
        event: event as never,
        resolve: (async () =>
          new Response("reached", { status: 200 })) as never,
      });
      expect(res.status, path).toBe(401);
      expect(await res.text()).not.toBe("reached");
    }
  });

  it("are not session cookies: the app pages refuse them as a cookie or a bearer", async () => {
    const w = await buildWorld();
    const c = await connect(w.a);
    const event = createTestEvent({
      url: "http://localhost/bills",
      cookies: { [SESSION_COOKIE]: c.accessToken },
    });
    const res = await handle({
      event: event as never,
      resolve: (async () => new Response("reached")) as never,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });
});
