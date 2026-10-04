import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  PENDING_COOKIE,
  PENDING_LOGIN_TTL_MS,
  MAX_PENDING_ATTEMPTS,
  getPendingLogin,
} from "$lib/server/auth/challenges";
import { authChallenges, getDB } from "$lib/server/db";
import {
  loginRateLimiter,
  secondFactorLimiter,
} from "$lib/server/auth/rate-limit";
import {
  SESSION_COOKIE,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { totpCode } from "$lib/server/auth/totp";
import {
  confirmTotpEnrolment,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent, outcome } from "$lib/testing/event";
import { actions as loginActions } from "../+page.server";
import { actions, load } from "./+page.server";

async function userWithTotp() {
  const u = await createTestUser({ username: "alice" });
  const { secret } = await startTotpEnrolment(u.id, u.username);
  // enrol in the past so the current step is still usable at login time
  const past = Date.now() - 5 * 60_000;
  const codes = await confirmTotpEnrolment(u.id, totpCode(secret, past), past);
  return { u, secret, codes };
}

async function passwordStep(u: { password: string }) {
  const event = createTestEvent({
    form: { username: "alice", password: u.password, redirectTo: "/bills" },
  });
  const r = await outcome(() => loginActions.default(event as never));
  const cookies = event.cookies as unknown as FakeCookies;
  return { r, token: cookies.get(PENDING_COOKIE), cookies };
}

const codeEvent = (token: string | undefined, code: string) =>
  createTestEvent({
    form: { code, redirectTo: "/bills" },
    cookies: token ? { [PENDING_COOKIE]: token } : {},
  });

describe("two-step login", () => {
  useTestDB();
  beforeEach(() => {
    loginRateLimiter.reset();
    secondFactorLimiter.reset();
  });

  it("the password step alone grants no session, only a pending state", async () => {
    const { u } = await userWithTotp();
    const { r, token, cookies } = await passwordStep(u);
    expect(r).toMatchObject({
      type: "redirect",
      location: "/login/verify?redirectTo=%2Fbills",
    });
    expect(token).toBeTruthy();
    expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
    // the pending token is not a session token
    expect(await validateSessionToken(token!)).toBeNull();
  });

  it("completes with a valid code and issues the session", async () => {
    const { u, secret } = await userWithTotp();
    const { token } = await passwordStep(u);
    const event = codeEvent(token, totpCode(secret, Date.now()));
    const r = await outcome(() => actions.default(event as never));
    expect(r).toMatchObject({ type: "redirect", location: "/bills" });
    const cookies = event.cookies as unknown as FakeCookies;
    const session = cookies.get(SESSION_COOKIE);
    expect((await validateSessionToken(session!))?.user.id).toBe(u.id);
    expect(await getPendingLogin(token)).toBeNull();
  });

  it("cannot skip the second step: missing, bogus or reused pending cookie", async () => {
    const { u, secret } = await userWithTotp();
    for (const token of [undefined, "bogus"]) {
      const event = codeEvent(token, totpCode(secret, Date.now()));
      const r = await outcome(() => actions.default(event as never));
      expect(r).toMatchObject({ type: "redirect" });
      expect(
        (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
      ).toBeUndefined();
    }
    const { token } = await passwordStep(u);
    const ok = codeEvent(token, totpCode(secret, Date.now()));
    await outcome(() => actions.default(ok as never));
    const again = codeEvent(token, totpCode(secret, Date.now()));
    await outcome(() => actions.default(again as never));
    expect(
      (again.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
    ).toBeUndefined();
  });

  it("the pending state grants no access to the app", async () => {
    const { u } = await userWithTotp();
    const { token } = await passwordStep(u);
    expect(await validateSessionToken(token!)).toBeNull();
    const r = await outcome(() =>
      load(createTestEvent({ cookies: { [PENDING_COOKIE]: token! } }) as never),
    );
    expect(r).toMatchObject({ type: "return" });
  });

  it("the pending state expires", async () => {
    const { u, secret } = await userWithTotp();
    const { token } = await passwordStep(u);
    await getDB()
      .update(authChallenges)
      .set({ expiresAt: new Date(Date.now() - 1) });
    expect(await getPendingLogin(token)).toBeNull();
    const event = codeEvent(token, totpCode(secret, Date.now()));
    const r = await outcome(() => actions.default(event as never));
    expect(r).toMatchObject({
      type: "redirect",
      location: expect.stringContaining("/login"),
    });
    expect(
      (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
    ).toBeUndefined();
    expect(PENDING_LOGIN_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it("load sends visitors without a pending login back to /login", async () => {
    const r = await outcome(() => load(createTestEvent() as never));
    expect(r).toMatchObject({ type: "redirect" });
  });

  it("rejects a wrong code and destroys the pending login after too many", async () => {
    const { u } = await userWithTotp();
    const { token } = await passwordStep(u);
    const wrong = () =>
      outcome(() => actions.default(codeEvent(token, "000000") as never));
    for (let i = 0; i < MAX_PENDING_ATTEMPTS - 1; i++) {
      expect(await wrong()).toMatchObject({ type: "fail", status: 400 });
    }
    expect(await wrong()).toMatchObject({ type: "redirect" });
    expect(await getPendingLogin(token)).toBeNull();
  });

  it("rate limits the second step independently of the password step", async () => {
    const { u } = await userWithTotp();
    for (let i = 0; i < 5; i++) {
      const { token } = await passwordStep(u);
      await outcome(() => actions.default(codeEvent(token, "000000") as never));
    }
    const { token } = await passwordStep(u);
    const r = await outcome(() =>
      actions.default(codeEvent(token, "000000") as never),
    );
    expect(r).toMatchObject({ type: "fail", status: 429 });
  });

  it("a replayed code is refused on the second login", async () => {
    const { u, secret } = await userWithTotp();
    const code = totpCode(secret, Date.now());
    const first = await passwordStep(u);
    expect(
      await outcome(() =>
        actions.default(codeEvent(first.token, code) as never),
      ),
    ).toMatchObject({ type: "redirect", location: "/bills" });
    const second = await passwordStep(u);
    expect(
      await outcome(() =>
        actions.default(codeEvent(second.token, code) as never),
      ),
    ).toMatchObject({ type: "fail", status: 400 });
  });

  it("accepts a recovery code once", async () => {
    const { u, codes } = await userWithTotp();
    const first = await passwordStep(u);
    expect(
      await outcome(() =>
        actions.default(codeEvent(first.token, codes[0]) as never),
      ),
    ).toMatchObject({ type: "redirect", location: "/bills" });
    const second = await passwordStep(u);
    expect(
      await outcome(() =>
        actions.default(codeEvent(second.token, codes[0]) as never),
      ),
    ).toMatchObject({ type: "fail", status: 400 });
  });

  it("cancel removes the pending login", async () => {
    const { u } = await userWithTotp();
    const { token } = await passwordStep(u);
    await outcome(() =>
      actions.cancel(
        createTestEvent({ cookies: { [PENDING_COOKIE]: token! } }) as never,
      ),
    );
    expect(
      await getDB()
        .select()
        .from(authChallenges)
        .where(eq(authChallenges.kind, "login")),
    ).toHaveLength(0);
  });

  it("users without a second factor still log in directly", async () => {
    const u = await createTestUser({ username: "alice" });
    const { r, cookies } = await passwordStep(u);
    expect(r).toMatchObject({ type: "redirect", location: "/bills" });
    expect(cookies.get(SESSION_COOKIE)).toBeTruthy();
  });
});
