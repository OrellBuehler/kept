import { describe, expect, it } from "vitest";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent } from "$lib/testing/event";
import { SESSION_COOKIE } from "$lib/server/auth/sessions";
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
    const { token } = loginTestUser(user);
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
});
