import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "$lib/server/auth/sessions";
import { revokeApiToken } from "$lib/server/auth/api-tokens";
import { apiTokens, getDB } from "$lib/server/db";
import {
  API_AUTH_FAILURES_PER_IP,
  apiAuthFailureLimiter,
} from "$lib/server/external-api/gate";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedToken } from "$lib/testing/external-api";
import { callMcp, callTool, initialize, rpc } from "$lib/testing/mcp";
import {
  MCP_REQUESTS_PER_MINUTE,
  mcpChallenge,
  mcpTokenLimiter,
  originRefusal,
} from "./gate";
import { MCP_MAX_BODY_BYTES } from "./handler";

afterEach(() => {
  vi.unstubAllEnvs();
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

describe("mcp gate: authentication", () => {
  useTestDB();

  it("answers 401 JSON with a Bearer challenge and no-store without a token", async () => {
    await createTestUser();
    const res = await callMcp(null, {
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="kept", resource_metadata="http://localhost/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ message: expect.any(String) });
  });

  it("answers 401, not a redirect, before any user exists", async () => {
    expect((await callMcp(null, { body: {} })).status).toBe(401);
  });

  it("refuses an unknown, a revoked and an expired token", async () => {
    const u = await createTestUser();
    expect((await initialize("kept_nope")).status).toBe(401);
    const revoked = await seedToken(u.id, ["bills:read"]);
    await revokeApiToken(u.id, revoked.info.id);
    const res = await initialize(revoked.token);
    expect(res.status).toBe(401);
    const expired = await seedToken(u.id, ["bills:read"]);
    await getDB()
      .update(apiTokens)
      .set({ expiresAt: new Date(1) })
      .where(eq(apiTokens.id, expired.info.id));
    expect((await initialize(expired.token)).status).toBe(401);
  });

  it("ignores a session cookie, with or without a bad token", async () => {
    const u = await createTestUser();
    const { token } = await loginTestUser(u);
    const cookies = { [SESSION_COOKIE]: token };
    expect((await callMcp(null, { cookies, body: {} })).status).toBe(401);
    expect(
      (
        await callMcp("kept_nope", {
          cookies,
          body: {},
        })
      ).status,
    ).toBe(401);
  });

  it("treats every spelling of the path as the MCP endpoint", async () => {
    const u = await createTestUser();
    const { token } = await loginTestUser(u);
    for (const path of [
      "/api/mcp",
      "/api/mcp/",
      "/api/%6dcp",
      "/api/mcp/deep/er",
    ]) {
      const res = await callMcp(null, {
        path,
        cookies: { [SESSION_COOKIE]: token },
        body: {},
      });
      expect(res.status, path).toBe(401);
    }
  });

  it("counts refused tokens per address and tells the address to back off", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < API_AUTH_FAILURES_PER_IP; i++) {
      expect((await initialize("kept_nope", { ip })).status).toBe(401);
    }
    const blocked = await initialize("kept_nope", { ip });
    expect(blocked.status).toBe(429);
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    expect((await initialize(token, { ip })).status).toBe(429);
    expect((await initialize(token, { ip: "198.51.100.10" })).status).toBe(200);
  });

  it("limits each token's requests per minute, per token", async () => {
    const u = await createTestUser();
    const busy = await seedToken(u.id, ["bills:read"]);
    const quiet = await seedToken(u.id, ["bills:read"]);
    for (let i = 0; i < MCP_REQUESTS_PER_MINUTE; i++) {
      mcpTokenLimiter.acquire(busy.info.id, busy.info.id);
    }
    const refused = await callMcp(busy.token, {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await rpc(quiet.token, "tools/list", {})).status).toBe(200);
  });

  it("records when the token was last used", async () => {
    const u = await createTestUser();
    const { token, info } = await seedToken(u.id, ["bills:read"]);
    await initialize(token);
    const [row] = await getDB().select().from(apiTokens);
    expect(row!.id).toBe(info.id);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("gives a token with only REST scopes nothing but whoami", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["links:write"]);
    const res = await rpc(token, "tools/list", {});
    expect(res.status).toBe(200);
    expect(
      (res.json.result!.tools as { name: string }[]).map((t) => t.name),
    ).toEqual(["whoami"]);
  });
});

describe("mcp gate: origin", () => {
  useTestDB();

  it("lets requests without an Origin through, as every non-browser client sends none", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    expect((await initialize(token)).status).toBe(200);
  });

  it("accepts the configured ORIGIN and refuses a foreign one", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    vi.stubEnv("ORIGIN", "http://localhost");
    expect(
      (await initialize(token, { headers: { origin: "http://localhost" } }))
        .status,
    ).toBe(200);
    const foreign = await initialize(token, {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.json).toEqual({ message: "This origin is not allowed." });
    // Refused before authentication: not even a bad token is looked at.
    expect(
      (
        await callMcp(null, {
          headers: { origin: "https://evil.example" },
          body: {},
        })
      ).status,
    ).toBe(403);
  });

  it("honours ORIGIN behind a proxy and a configured extra list", () => {
    const req = (origin: string) =>
      new Request("http://internal:3000/api/mcp", { headers: { origin } });
    const saved = process.env.ORIGIN;
    try {
      process.env.ORIGIN = "https://kept.example.org";
      expect(originRefusal(req("https://kept.example.org"))).toBeNull();
      expect(originRefusal(req("https://other.example.org"))?.status).toBe(403);
      expect(
        originRefusal(
          req("http://localhost:6274"),
          "http://localhost:6274/, https://x.example",
        ),
      ).toBeNull();
      expect(originRefusal(req("null"), "http://localhost:6274")?.status).toBe(
        403,
      );
    } finally {
      if (saved === undefined) delete process.env.ORIGIN;
      else process.env.ORIGIN = saved;
    }
  });
});

describe("mcp gate: origin without ORIGIN", () => {
  const req = (origin: string | null) =>
    new Request("http://rebound.example:3000/api/mcp", {
      headers: origin === null ? {} : { origin },
    });

  it("does not trust the request's own host as an origin", () => {
    const saved = process.env.ORIGIN;
    try {
      delete process.env.ORIGIN;
      expect(originRefusal(req("http://rebound.example:3000"))?.status).toBe(
        403,
      );
      expect(originRefusal(req("http://localhost"))?.status).toBe(403);
    } finally {
      if (saved !== undefined) process.env.ORIGIN = saved;
    }
  });

  it("accepts a listed origin and requests without an Origin header", () => {
    const saved = process.env.ORIGIN;
    try {
      delete process.env.ORIGIN;
      expect(
        originRefusal(req("https://tool.example"), "https://tool.example/"),
      ).toBeNull();
      expect(originRefusal(req(null))).toBeNull();
    } finally {
      if (saved !== undefined) process.env.ORIGIN = saved;
    }
  });
});

describe("mcp gate: transport", () => {
  useTestDB();

  it("answers GET and DELETE with 405 after authenticating (stateless: no stream, no session)", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    for (const method of ["GET", "DELETE"]) {
      const res = await callMcp(token, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const noToken = await callMcp(null, { method });
      expect(noToken.status, method).toBe(401);
    }
  });

  it("rejects bodies over the limit and bodies that are not JSON-RPC", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    const big = await callMcp(token, {
      headers: { "content-length": String(MCP_MAX_BODY_BYTES + 1) },
      body: "{}",
    });
    expect(big.status).toBe(413);
    const huge = await callMcp(token, {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { pad: "x".repeat(MCP_MAX_BODY_BYTES) },
      }),
    });
    expect(huge.status).toBe(413);
    expect((await callMcp(token, { body: "not json" })).status).toBe(400);
    expect((await callMcp(token, { body: { hello: "world" } })).status).toBe(
      400,
    );
  });

  it("requires JSON and the two accept types", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect(
      (
        await callMcp(token, {
          body,
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(415);
    expect(
      (await callMcp(token, { body, headers: { accept: "application/json" } }))
        .status,
    ).toBe(406);
  });

  it("serves a stateless initialize with no session id and never keeps state between requests", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:read"]);
    const init = await callMcp(token, {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    // A later call works without any session.
    expect((await callTool(token, "whoami")).isError).toBe(false);
  });

  it("does not log tool arguments or results", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ["bills:write"]);
    const logged: string[] = [];
    const original = [console.log, console.error, console.warn, console.info];
    for (const fn of ["log", "error", "warn", "info"] as const) {
      console[fn] = (...a: unknown[]) => logged.push(a.map(String).join(" "));
    }
    try {
      await callTool(token, "create_bill", {
        creditorName: "Very Private Creditor",
        amount: "123.45",
        notes: "secret note",
      });
      await callTool(token, "create_bill", { amount: "9" });
    } finally {
      [console.log, console.error, console.warn, console.info] = original as [
        typeof console.log,
        typeof console.error,
        typeof console.warn,
        typeof console.info,
      ];
    }
    expect(logged.join("\n")).not.toMatch(/Private|123\.45|secret/);
  });

  it("points the challenge at the protected-resource metadata, and names a refused credential", () => {
    expect(mcpChallenge("https://kept.example.org")).toBe(
      'Bearer realm="kept", resource_metadata="https://kept.example.org/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(mcpChallenge("https://kept.example.org", true)).toBe(
      'Bearer realm="kept", error="invalid_token", resource_metadata="https://kept.example.org/.well-known/oauth-protected-resource/api/mcp"',
    );
  });
});
