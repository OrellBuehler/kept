import { describe, expect, it, vi } from "vitest";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent } from "$lib/testing/event";
import { API_SCOPES } from "$lib/api-tokens";
import { revokeApiToken } from "$lib/server/auth/api-tokens";
import { loginRateLimiter } from "$lib/server/auth/rate-limit";
import {
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
  createSession,
  invalidateSession,
} from "$lib/server/auth/sessions";
import {
  runLoad,
  type PageModule,
  type Route,
} from "$lib/server/app-api/bridge";
import { POST as loginPost } from "./routes/api/app/v1/auth/login/+server";
import {
  API_AUTH_FAILURES_PER_IP,
  API_REQUESTS_PER_MINUTE,
  apiAuthFailureLimiter,
  apiTokenLimiter,
} from "$lib/server/external-api/gate";
import { seedToken } from "$lib/testing/external-api";
import {
  APP_AUTH_FAILURES_PER_IP,
  appAuthFailureLimiter,
} from "$lib/server/app-api/gate";
import { handle, handleError } from "./hooks.server";

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

describe("handle: app API", () => {
  useTestDB();

  async function app(
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

  it("lets server discovery and the sign-in steps through without a session", async () => {
    await createTestUser();
    for (const p of [
      "/server",
      "/auth/login",
      "/auth/verify",
      "/auth/browser",
      "/auth/browser/token",
    ]) {
      const { res, resolved, event } = await app(`/api/app/v1${p}`);
      expect(res.status, p).toBe(200);
      expect(resolved(), p).toBe(true);
      expect(event.locals.user, p).toBeNull();
      expect(res.headers.get("cache-control"), p).toBe("no-store");
    }
  });

  it("answers 401 JSON without a bearer token, also before any user exists", async () => {
    const { res, resolved } = await app("/api/app/v1/session");
    expect(res.status).toBe(401);
    expect(resolved()).toBe(false);
    expect(await res.json()).toEqual({ message: "Sign in to continue." });
  });

  it("accepts a session token as bearer token", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const { res, event } = await app("/api/app/v1/session", {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    expect(event.locals.user).toMatchObject({ id: user.id });
    expect(event.locals.session).not.toBeNull();
    expect(event.locals.apiToken).toBeNull();
  });

  it("does not honour a session cookie on the prefix, in any spelling", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    for (const p of [
      "/api/app/v1/session",
      "/api/%61pp/v1/pages/bills",
      "/api/app/v1/auth/logout",
      "/api/app/v1/auth/login/extra",
    ]) {
      const { res, resolved, event } = await app(
        p,
        {},
        { [SESSION_COOKIE]: token },
      );
      expect(res.status, p).toBe(401);
      expect(resolved(), p).toBe(false);
      expect(event.locals.user, p).toBeNull();
    }
  });

  it("an API token is not a session, and a session token is no API token", async () => {
    const user = await createTestUser();
    const { token: apiToken } = await seedToken(user.id, [...API_SCOPES]);
    const { token } = await loginTestUser(user);
    const asSession = await app("/api/app/v1/session", {
      authorization: `Bearer ${apiToken}`,
    });
    expect(asSession.res.status).toBe(401);
    const asApiToken = await app("/api/external/v1/me", {
      authorization: `Bearer ${token}`,
    });
    expect(asApiToken.res.status).toBe(401);
  });

  it("a bearer session token counts nowhere else", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const { res, event } = await app("/bills", {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(303);
    expect(event.locals.user).toBeNull();
  });

  it("answers floods of malformed bearers from one address with 429", async () => {
    appAuthFailureLimiter.reset();
    await createTestUser();
    const headers = { authorization: "Bearer not-a-session" };
    for (let i = 0; i < APP_AUTH_FAILURES_PER_IP; i++) {
      const { res } = await app("/api/app/v1/session", headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const { res, resolved } = await app("/api/app/v1/session", headers);
    expect(res.status).toBe(429);
    expect(resolved()).toBe(false);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ message: expect.any(String) });
    appAuthFailureLimiter.reset();
  });

  it("answers 401 with no-store, also without a bearer token", async () => {
    const { res } = await app("/api/app/v1/session");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never rate limits well-formed tokens that match no session", async () => {
    appAuthFailureLimiter.reset();
    const user = await createTestUser();
    const ended = await createSession(user.id);
    await invalidateSession(ended.session.id);
    const expired = await createSession(
      user.id,
      Date.now() - SESSION_LIFETIME_MS - 1000,
    );
    const unknown = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64url");
    for (const token of [ended.token, expired.token, unknown]) {
      for (let i = 0; i < APP_AUTH_FAILURES_PER_IP * 2; i++) {
        const { res, resolved } = await app("/api/app/v1/session", {
          authorization: `Bearer ${token}`,
        });
        expect(res.status).toBe(401);
        expect(resolved()).toBe(false);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
    const { token } = await loginTestUser(user);
    const { res } = await app("/api/app/v1/session", {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
  });

  it("lets many concurrent valid requests through", async () => {
    appAuthFailureLimiter.reset();
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const results = await Promise.all(
      Array.from({ length: APP_AUTH_FAILURES_PER_IP * 3 }, () =>
        app("/api/app/v1/session", { authorization: `Bearer ${token}` }),
      ),
    );
    expect(results.map((r) => r.res.status)).toEqual(results.map(() => 200));
  });

  it("serves public paths without a user, whatever credentials come with them", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    for (const p of ["/server", "/auth/login", "/%73erver"]) {
      const { res, event } = await app(
        `/api/app/v1${p}`,
        { authorization: `Bearer ${token}` },
        { [SESSION_COOKIE]: token },
      );
      expect(res.status, p).toBe(200);
      expect(event.locals.user, p).toBeNull();
      expect(event.locals.session, p).toBeNull();
    }
  });

  it("answers a wrong password with its JSON message, whatever the Accept header", async () => {
    loginRateLimiter.reset();
    const user = await createTestUser({ username: "alice" });
    for (const accept of [undefined, "text/html", "application/json"]) {
      const event = createTestEvent({
        url: "http://localhost/api/app/v1/auth/login",
        body: JSON.stringify({ username: "alice", password: "wrong-password" }),
        headers: {
          "content-type": "application/json",
          ...(accept ? { accept } : {}),
        },
      });
      const res = await handle({
        event: event as never,
        resolve: ((e: never) => loginPost(e)) as never,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        message: "Invalid username or password.",
      });
    }
    expect(user.username).toBe("alice");
    loginRateLimiter.reset();
  });

  it("a bridged handler's unexpected error becomes a clean JSON 500 naming the page pattern in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createTestUser();
      const { token } = await loginTestUser(user);
      const failing: Route<PageModule> = {
        api: "bills/[id]",
        routeId: "/(app)/bills/[id]",
        web: "/bills/[id]",
        module: async () => ({
          load: () => {
            throw new Error("secret detail SELECT * FROM bills");
          },
        }),
      };
      for (const accept of [undefined, "text/html", "application/json"]) {
        const event = createTestEvent({
          url: "http://localhost/api/app/v1/pages/bills/b1d2c3?month=2026-01",
          params: { path: "bills/b1d2c3" },
          headers: {
            authorization: `Bearer ${token}`,
            ...(accept ? { accept } : {}),
          },
        });
        event.route.id = "/api/app/v1/pages/[...path]";
        // SvelteKit's part: an error out of the handler goes to handleError and is rendered by Accept.
        const resolve = async (e: typeof event) => {
          try {
            return await runLoad(e as never, {
              route: failing,
              params: { id: "b1d2c3" },
            });
          } catch (err) {
            const shown = handleError({
              kind: "unknown",
              error: err,
              event: e,
            } as never) as { message: string };
            return new Response(`<html>${shown.message}</html>`, {
              status: 500,
              headers: { "content-type": "text/html" },
            });
          }
        };
        const res = await handle({
          event: event as never,
          resolve: resolve as never,
        });
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual({
          message: "An unexpected error occurred.",
        });
      }
      expect(log).toHaveBeenCalledTimes(3);
      for (const [line, detail] of log.mock.calls) {
        expect(String(line)).toContain(
          "route=/api/app/v1/pages/[...path] bridged=bills/[id]",
        );
        expect(String(line)).not.toContain("b1d2c3");
        expect(String(line)).not.toContain("month");
        expect(String(detail)).not.toContain("SELECT");
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("handleError", () => {
  const event = createTestEvent({ url: "http://localhost/accounts" });
  const report = (input: object) =>
    handleError({ ...input, event } as never) as unknown;

  it("leaves errors thrown with error() as they are, without logging", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        report({ kind: "app", error: { message: "Account not found" } }),
      ).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("logs an unexpected error as a 500 under an id and hides its message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = report({
        kind: "unknown",
        error: new Error("secret detail"),
      }) as { message: string; errorId: string };
      expect(result.message).toBe("An unexpected error occurred.");
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]![0])).toContain(
        `unhandled error ${result.errorId} status=500`,
      );
      expect(JSON.stringify(result)).not.toContain("secret detail");
    } finally {
      log.mockRestore();
    }
  });

  it("logs a framework error with its own status", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = report({
        kind: "framework",
        error: { status: 404, message: "Not Found" },
      }) as { errorId: string };
      expect(result.errorId).toBeTruthy();
      expect(String(log.mock.calls[0]![0])).toContain("status=404");
    } finally {
      log.mockRestore();
    }
  });
});
