import { beforeEach, describe, expect, it } from "vitest";
import { loginRateLimiter } from "$lib/server/auth/rate-limit";
import {
  SESSION_COOKIE,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

describe("login", () => {
  useTestDB();
  beforeEach(() => loginRateLimiter.reset());

  it("load exposes a validated redirectTo", async () => {
    const ok = createTestEvent({
      url: "http://localhost/login?redirectTo=/admin/users",
    });
    expect(await outcome(() => load(ok as never))).toEqual({
      type: "return",
      value: { redirectTo: "/admin/users" },
    });
    const evil = createTestEvent({
      url: "http://localhost/login?redirectTo=//evil.com",
    });
    expect(await outcome(() => load(evil as never))).toEqual({
      type: "return",
      value: { redirectTo: "/" },
    });
  });

  it("load redirects logged-in users away", async () => {
    const u = await createTestUser();
    const event = createTestEvent({
      user: u,
      url: "http://localhost/login?redirectTo=/settings/account",
    });
    expect(await outcome(() => load(event as never))).toMatchObject({
      type: "redirect",
      location: "/settings/account",
    });
  });

  it("logs in, sets the cookie and redirects to a safe redirectTo", async () => {
    const u = await createTestUser({ username: "alice" });
    const event = createTestEvent({
      form: {
        username: " Alice ",
        password: u.password,
        redirectTo: "/settings/account",
      },
    });
    expect(await outcome(() => actions.default(event as never))).toMatchObject({
      type: "redirect",
      status: 303,
      location: "/settings/account",
    });
    expect(
      (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
    ).toBeTruthy();
  });

  it.each(["//evil.com", "https://evil.com/x", "javascript:alert(1)"])(
    "ignores unsafe redirectTo %s",
    async (bad) => {
      const u = await createTestUser({ username: "alice" });
      const event = createTestEvent({
        form: { username: "alice", password: u.password, redirectTo: bad },
      });
      expect(
        await outcome(() => actions.default(event as never)),
      ).toMatchObject({
        type: "redirect",
        location: "/",
      });
    },
  );

  it("fails with a generic message and no cookie on bad credentials", async () => {
    await createTestUser({ username: "alice" });
    for (const username of ["alice", "nobody"]) {
      const event = createTestEvent({
        form: { username, password: "not-the-password" },
      });
      const r = await outcome(() => actions.default(event as never));
      expect(r).toEqual({
        type: "fail",
        status: 400,
        data: {
          errors: { form: ["Invalid username or password."] },
          values: { username },
        },
      });
      expect(
        (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
      ).toBeUndefined();
    }
  });

  it("invalidates the pre-existing session on login", async () => {
    const u = await createTestUser({ username: "alice" });
    const old = loginTestUser(u);
    const event = createTestEvent({
      user: u,
      session: old.session,
      form: { username: "alice", password: u.password },
    });
    await outcome(() => actions.default(event as never));
    expect(validateSessionToken(old.token)).toBeNull();
  });

  it("fails validation on empty fields", async () => {
    const r = await outcome(() =>
      actions.default(
        createTestEvent({ form: { username: "", password: "" } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });

  it("rate limits after repeated failures with a 429 and wait time", async () => {
    await createTestUser({ username: "alice" });
    const attempt = () =>
      outcome(() =>
        actions.default(
          createTestEvent({
            form: { username: "alice", password: "not-the-password" },
          }) as never,
        ),
      );
    for (let i = 0; i < 5; i++) await attempt();
    const r = await attempt();
    expect(r).toMatchObject({ type: "fail", status: 429 });
    expect(JSON.stringify(r)).toContain("try again in 15 minutes");
  });
});
