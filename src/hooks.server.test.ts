import { describe, expect, it, vi } from "vitest";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent } from "$lib/testing/event";
import { API_SCOPES } from "$lib/api-tokens";
import { revokeApiToken } from "$lib/server/auth/api-tokens";
import { SESSION_COOKIE } from "$lib/server/auth/sessions";
import {
  API_AUTH_FAILURES_PER_IP,
  API_REQUESTS_PER_MINUTE,
  apiAuthFailureLimiter,
  apiTokenLimiter,
} from "$lib/server/external-api/gate";
import { seedToken } from "$lib/testing/external-api";
import { handle } from "./hooks.server";

async function run(path: string, cookies: Record<string, string> = {}) {
  const event = createTestEvent({ url: `http://localhost${path}`, cookies });
  const resolve = async () => new Response("ok", { status: 200 });
  const res = await handle({
    event: event as never,
    resolve: resolve as never,
  });
  return { res, event };
}

describe("handle", () => {
  useTestDB();

  it("redirects everything non-public to /setup while no user exists", async () => {
    for (const p of ["/", "/admin/users", "/api/things"]) {
      const { res } = await run(p);
      expect(res.status, p).toBe(303);
      expect(res.headers.get("location"), p).toBe("/setup");
    }
  });

  it("lets public paths through with no users", async () => {
    for (const p of ["/setup", "/login", "/api/health", "/api/public/hook"]) {
      expect((await run(p)).res.status, p).toBe(200);
    }
  });

  it("redirects unauthenticated pages to /login with redirectTo", async () => {
    await createTestUser();
    const { res } = await run("/admin/users?tab=1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirectTo=${encodeURIComponent("/admin/users?tab=1")}`,
    );
  });

  it("answers unauthenticated /api with 401 JSON", async () => {
    await createTestUser();
    const { res } = await run("/api/things");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required" });
  });

  it("keeps public paths public once users exist", async () => {
    await createTestUser();
    for (const p of ["/login", "/setup", "/api/health", "/api/public/x"]) {
      expect((await run(p)).res.status, p).toBe(200);
    }
  });

  it("resolves locals from a valid session cookie", async () => {
    const user = await createTestUser({ role: "admin" });
    const { token } = await loginTestUser(user);
    const { res, event } = await run("/", { [SESSION_COOKIE]: token });
    expect(res.status).toBe(200);
    expect(event.locals.user).toMatchObject({ id: user.id, role: "admin" });
    expect(event.locals.session).not.toBeNull();
  });

  it("early-return redirects and 401s also clear a stale cookie", async () => {
    await createTestUser();
    for (const p of ["/", "/api/things"]) {
      const { res } = await run(p, { [SESSION_COOKIE]: "stale" });
      expect(res.headers.get("set-cookie"), p).toMatch(
        new RegExp(`^${SESSION_COOKIE}=; Expires=`),
      );
    }
  });

  it("does not set a clearing cookie when none was sent", async () => {
    await createTestUser();
    const { res } = await run("/");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("clears a cookie that does not match a session", async () => {
    await createTestUser();
    const { res, event } = await run("/", { [SESSION_COOKIE]: "stale" });
    expect(res.status).toBe(303);
    expect(event.locals.user).toBeNull();
    expect((event.cookies as unknown as FakeCookies).deleted).toContain(
      SESSION_COOKIE,
    );
  });

  it("adds security headers to resolved, redirect and 401 responses", async () => {
    await createTestUser();
    for (const p of ["/login", "/", "/api/things"]) {
      const { res } = await run(p);
      expect(res.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), p).toBe("same-origin");
      expect(res.headers.get("content-security-policy"), p).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.headers.has("strict-transport-security"), p).toBe(false);
    }
  });

  it("adds HSTS when the request is https", async () => {
    const event = createTestEvent({ url: "https://kept.test/login" });
    const res = await handle({
      event: event as never,
      resolve: (async () => new Response("ok")) as never,
    });
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
  });
});

describe("handle: external API", () => {
  useTestDB();

  async function ext(
    path: string,
    headers: Record<string, string> = {},
    cookies: Record<string, string> = {},
  ) {
    const event = createTestEvent({
      url: `http://localhost${path}`,
      headers,
      cookies,
    });
    let resolved = false;
    const resolve = async () => {
      resolved = true;
      return new Response("ok", { status: 200 });
    };
    const res = await handle({
      event: event as never,
      resolve: resolve as never,
    });
    return { res, event, resolved: () => resolved };
  }

  it("answers 401 JSON with a challenge when there is no bearer token", async () => {
    await createTestUser();
    const { res, resolved } = await ext("/api/external/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toEqual({ message: expect.any(String) });
    expect(resolved()).toBe(false);
  });

  it("answers 401, not a redirect, before any user exists", async () => {
    const { res } = await ext("/api/external/v1/bills");
    expect(res.status).toBe(401);
  });

  it("does not honour a session cookie on the prefix", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const { res, event, resolved } = await ext(
      "/api/external/v1/me",
      {},
      { [SESSION_COOKIE]: token },
    );
    expect(res.status).toBe(401);
    expect(resolved()).toBe(false);
    expect(event.locals.user).toBeNull();
    expect(event.locals.session).toBeNull();
  });

  it("does not honour a cookie next to a refused bearer token either", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const { res } = await ext(
      "/api/external/v1/me",
      { authorization: "Bearer kept_nope" },
      { [SESSION_COOKIE]: token },
    );
    expect(res.status).toBe(401);
  });

  it("treats every spelling of the prefix as external", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    for (const p of [
      "/api/external/v1",
      "/api/external/v1/",
      "/api/%65xternal/v1/me",
      "/api/external/v1/unknown/deep/path",
    ]) {
      const { res, resolved } = await ext(p, {}, { [SESSION_COOKIE]: token });
      expect(res.status, p).toBe(401);
      expect(resolved(), p).toBe(false);
    }
  });

  it("authenticates a valid token: locals carry the token, never a user", async () => {
    const user = await createTestUser();
    const { token } = await seedToken(user.id, ["bills:read"]);
    const { res, event, resolved } = await ext("/api/external/v1/bills", {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    expect(resolved()).toBe(true);
    expect(event.locals.user).toBeNull();
    expect(event.locals.session).toBeNull();
    expect(event.locals.apiToken).toMatchObject({
      userId: user.id,
      scopes: ["bills:read"],
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts the Bearer scheme in any case and ignores other schemes", async () => {
    const user = await createTestUser();
    const { token } = await seedToken(user.id, ["bills:read"]);
    expect(
      (await ext("/api/external/v1/x", { authorization: `bearer ${token}` }))
        .res.status,
    ).toBe(200);
    for (const h of [`Basic ${token}`, `Bearer`, `Bearer a b`, token]) {
      expect(
        (await ext("/api/external/v1/x", { authorization: h })).res.status,
        h,
      ).toBe(401);
    }
  });

  it("refuses revoked, expired and malformed tokens with 401", async () => {
    const user = await createTestUser();
    const revoked = await seedToken(user.id, ["bills:read"]);
    await revokeApiToken(user.id, revoked.info.id);
    const expired = await seedToken(user.id, ["bills:read"], {
      expiresAt: new Date(Date.now() + 1000),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      for (const t of [revoked.token, expired.token, "kept_nope", "garbage"]) {
        const { res, resolved } = await ext("/api/external/v1/bills", {
          authorization: `Bearer ${t}`,
        });
        expect(res.status, t).toBe(401);
        expect(resolved(), t).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("never echoes the presented token in a response", async () => {
    await createTestUser();
    const presented = "kept_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { res } = await ext("/api/external/v1/me", {
      authorization: `Bearer ${presented}`,
    });
    expect(JSON.stringify(await res.json())).not.toContain(presented);
    expect([...res.headers.values()].join("\n")).not.toContain(presented);
  });

  it("ignores a bearer token outside the prefix", async () => {
    const user = await createTestUser();
    const { token } = await seedToken(user.id, [...API_SCOPES]);
    const auth = { authorization: `Bearer ${token}` };
    for (const p of [
      "/api/things",
      "/api/health-not",
      "/",
      "/bills",
      "/api/externalx/v1/me",
    ]) {
      const { res, resolved, event } = await ext(p, auth);
      expect(res.status, p).toBe(p.startsWith("/api") ? 401 : 303);
      expect(resolved(), p).toBe(false);
      expect(event.locals.user, p).toBeNull();
      expect(event.locals.apiToken, p).toBeNull();
    }
    expect((await ext("/api/health", auth)).event.locals.apiToken).toBeNull();
  });

  it("answers rejected-token floods from one address with 429", async () => {
    await createTestUser();
    apiAuthFailureLimiter.reset();
    const statuses: number[] = [];
    for (let i = 0; i < API_AUTH_FAILURES_PER_IP + 3; i++) {
      const { res } = await ext("/api/external/v1/me", {
        authorization: "Bearer kept_nope",
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
    }
    expect(
      statuses.slice(0, API_AUTH_FAILURES_PER_IP).every((s) => s === 401),
    ).toBe(true);
    expect(statuses.slice(API_AUTH_FAILURES_PER_IP)).toEqual([429, 429, 429]);
    apiAuthFailureLimiter.reset();
  });

  it("a revoked or expired token does not lock out valid ones from the same address", async () => {
    const user = await createTestUser();
    const stale = await seedToken(user.id, ["bills:read"]);
    await revokeApiToken(user.id, stale.info.id);
    const good = await seedToken(user.id, ["bills:read"]);
    apiAuthFailureLimiter.reset();
    for (let i = 0; i < API_AUTH_FAILURES_PER_IP + 5; i++) {
      const { res } = await ext("/api/external/v1/x", {
        authorization: `Bearer ${stale.token}`,
      });
      expect(res.status).toBe(401);
    }
    const { res } = await ext("/api/external/v1/x", {
      authorization: `Bearer ${good.token}`,
    });
    expect(res.status).toBe(200);
  });

  it("valid requests do not use up the failure budget", async () => {
    const user = await createTestUser();
    const { token } = await seedToken(user.id, ["bills:read"]);
    apiAuthFailureLimiter.reset();
    for (let i = 0; i < API_AUTH_FAILURES_PER_IP + 5; i++) {
      const { res } = await ext("/api/external/v1/x", {
        authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(200);
    }
    apiTokenLimiter.reset();
  });

  it("limits requests per token and tells when to come back", async () => {
    const user = await createTestUser();
    const { token } = await seedToken(user.id, ["bills:read"]);
    apiTokenLimiter.reset();
    let limited = 0;
    for (let i = 0; i < API_REQUESTS_PER_MINUTE + 5; i++) {
      const { res } = await ext("/api/external/v1/x", {
        authorization: `Bearer ${token}`,
      });
      if (res.status === 429) {
        limited++;
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      } else expect(res.status).toBe(200);
    }
    expect(limited).toBe(5);
    const other = await seedToken(user.id, ["bills:read"]);
    const { res } = await ext("/api/external/v1/x", {
      authorization: `Bearer ${other.token}`,
    });
    expect(res.status).toBe(200);
    apiTokenLimiter.reset();
  });

  it("turns non-JSON error responses of the router into JSON", async () => {
    const user = await createTestUser();
    const { token } = await seedToken(user.id, ["bills:read"]);
    const event = createTestEvent({
      url: "http://localhost/api/external/v1/nothing",
      headers: { authorization: `Bearer ${token}`, accept: "text/html" },
    });
    const res = await handle({
      event: event as never,
      resolve: (async () =>
        new Response("<h1>Not Found</h1>", {
          status: 404,
          headers: { "content-type": "text/html" },
        })) as never,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ message: "Not found" });
  });
});
