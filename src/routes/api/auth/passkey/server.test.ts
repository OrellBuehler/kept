import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_COOKIE,
  createPendingLogin,
  getPendingLogin,
} from "$lib/server/auth/challenges";
import {
  passkeyLoginLimiter,
  passkeyOptionsLimiter,
  secondFactorLimiter,
} from "$lib/server/auth/rate-limit";
import {
  SESSION_COOKIE,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { eq } from "drizzle-orm";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { REAUTH_WINDOW_MS } from "$lib/server/auth/two-factor";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent } from "$lib/testing/event";
import { hasRecentReauth } from "$lib/server/auth/two-factor";
import { getDB, passkeys, sessions } from "$lib/server/db";

const verifyReg = vi.fn();
const verifyAuth = vi.fn();
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: (o: unknown) => verifyReg(o),
  verifyAuthenticationResponse: (o: unknown) => verifyAuth(o),
}));

const { POST: registerOptions } = await import("./register/options/+server");
const { POST: registerVerify } = await import("./register/verify/+server");
const { POST: stepupOptions } = await import("./stepup/options/+server");
const { POST: stepupVerify } = await import("./stepup/verify/+server");
const { POST: loginOptions } = await import("./login/options/+server");
const { POST: loginVerify } = await import("./login/verify/+server");

const ORIGIN = "http://localhost";
const post = (
  path: string,
  body: unknown,
  extra: Parameters<typeof createTestEvent>[0] = {},
) =>
  createTestEvent({
    url: `${ORIGIN}${path}`,
    body: JSON.stringify(body),
    headers: { origin: ORIGIN, "content-type": "application/json" },
    ...extra,
  });

function sess(
  u: Awaited<ReturnType<typeof createTestUser>>,
  reauthAgeMs: number | null = 0,
) {
  const s = loginTestUser(u);
  if (reauthAgeMs !== null) {
    getDB()
      .update(sessions)
      .set({ reauthAt: new Date(Date.now() - reauthAgeMs) })
      .where(eq(sessions.id, s.session.id))
      .run();
  }
  return { user: u, session: s.session };
}

const credential = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key",
  response: {},
  clientExtensionResults: {},
};

async function call(handler: unknown, event: unknown) {
  try {
    const res = await (handler as (e: never) => Promise<Response>)(
      event as never,
    );
    return { status: res.status, body: await res.json() };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status) return { status, body: null };
    throw err;
  }
}

function seedPasskey(userId: string) {
  getDB()
    .insert(passkeys)
    .values({
      userId,
      name: "k",
      credentialId: "cred-1",
      publicKey: "AQID",
      deviceType: "singleDevice",
      backedUp: false,
    })
    .run();
}

describe("passkey api", () => {
  useTestDB();
  beforeEach(() => {
    verifyReg.mockReset();
    verifyAuth.mockReset();
    passkeyLoginLimiter.reset();
    passkeyOptionsLimiter.reset();
    secondFactorLimiter.reset();
  });

  it("registration endpoints require a user", async () => {
    expect((await call(registerOptions, post("/x", {}))).status).toBe(401);
    expect(
      (
        await call(
          registerVerify,
          post("/x", { challengeId: "a", name: "n", credential }),
        )
      ).status,
    ).toBe(401);
  });

  it("registration needs a recent step-up: none or stale is rejected, fresh works", async () => {
    const u = await createTestUser();
    for (const age of [null, REAUTH_WINDOW_MS + 1000]) {
      const o = await call(registerOptions, post("/x", {}, sess(u, age)));
      expect(o).toMatchObject({
        status: 403,
        body: { code: "reauth_required" },
      });
      const v = await call(
        registerVerify,
        post("/x", { challengeId: "a", name: "n", credential }, sess(u, age)),
      );
      expect(v).toMatchObject({
        status: 403,
        body: { code: "reauth_required" },
      });
    }
    expect(
      (await call(registerOptions, post("/x", {}, sess(u, 1000)))).status,
    ).toBe(200);
  });

  it("rejects cross-origin and non-json requests", async () => {
    const u = await createTestUser();
    const cross = post(
      "/x",
      {},
      {
        user: u,
        headers: {
          origin: "http://evil.test",
          "content-type": "application/json",
        },
      },
    );
    expect((await call(registerOptions, cross)).status).toBe(403);
    const wrongType = post(
      "/x",
      {},
      { ...sess(u), headers: { origin: ORIGIN, "content-type": "text/plain" } },
    );
    expect((await call(registerOptions, wrongType)).status).toBe(415);
    const bad = post("/x", { nope: 1 }, sess(u));
    expect((await call(registerVerify, bad)).status).toBe(400);
  });

  it("registers a passkey: challenge is single-use and bound to the user", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const opts = await call(registerOptions, post("/x", {}, sess(u)));
    expect(opts.status).toBe(200);
    const { challengeId } = opts.body;

    const wrongUser = await call(
      registerVerify,
      post("/x", { challengeId, name: "n", credential }, sess(other)),
    );
    expect(wrongUser.status).toBe(400);

    // the failed attempt consumed the challenge
    verifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    const replay = await call(
      registerVerify,
      post("/x", { challengeId, name: "n", credential }, sess(u)),
    );
    expect(replay.status).toBe(400);

    const fresh = await call(registerOptions, post("/x", {}, sess(u)));
    const ok = await call(
      registerVerify,
      post(
        "/x",
        { challengeId: fresh.body.challengeId, name: "Laptop", credential },
        sess(u),
      ),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.passkey.name).toBe("Laptop");
    expect(JSON.stringify(ok.body)).not.toContain("publicKey");
  });

  it("passwordless login issues a session and consumes the challenge", async () => {
    const u = await createTestUser();
    seedPasskey(u.id);
    const opts = await call(loginOptions, post("/x", { mode: "passwordless" }));
    expect(opts.status).toBe(200);
    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    const event = post("/x", {
      challengeId: opts.body.challengeId,
      credential,
      redirectTo: "/bills",
    });
    const ok = await call(loginVerify, event);
    expect(ok).toMatchObject({ status: 200, body: { redirectTo: "/bills" } });
    const token = (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE);
    expect(validateSessionToken(token!)?.user.id).toBe(u.id);

    const replay = post("/x", {
      challengeId: opts.body.challengeId,
      credential,
    });
    expect((await call(loginVerify, replay)).status).toBe(400);
    expect(
      (replay.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
    ).toBeUndefined();
  });

  it("passwordless login fails on bad verification and unknown challenge", async () => {
    const u = await createTestUser();
    seedPasskey(u.id);
    const opts = await call(loginOptions, post("/x", { mode: "passwordless" }));
    verifyAuth.mockResolvedValue({ verified: false });
    const event = post("/x", {
      challengeId: opts.body.challengeId,
      credential,
    });
    expect((await call(loginVerify, event)).status).toBe(400);
    expect(
      (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
    ).toBeUndefined();
    expect(
      (await call(loginVerify, post("/x", { challengeId: "nope", credential })))
        .status,
    ).toBe(400);
  });

  it("second-factor options and verify need a live pending login", async () => {
    expect(
      (await call(loginOptions, post("/x", { mode: "second_factor" }))).status,
    ).toBe(401);
    expect((await call(loginVerify, post("/x", { credential }))).status).toBe(
      401,
    );
  });

  it("second-factor login only accepts the pending user's passkey", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    seedPasskey(other.id);
    const { token } = createPendingLogin(u.id);
    const cookies = { [PENDING_COOKIE]: token };
    // user has no passkey
    expect(
      (
        await call(
          loginOptions,
          post("/x", { mode: "second_factor" }, { cookies }),
        )
      ).status,
    ).toBe(400);

    getDB().delete(passkeys).run();
    seedPasskey(u.id);
    const opts = await call(
      loginOptions,
      post("/x", { mode: "second_factor" }, { cookies }),
    );
    expect(opts.status).toBe(200);
    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    const event = post("/x", { credential }, { cookies });
    const ok = await call(loginVerify, event);
    expect(ok.status).toBe(200);
    const session = (event.cookies as unknown as FakeCookies).get(
      SESSION_COOKIE,
    );
    expect(validateSessionToken(session!)?.user.id).toBe(u.id);
    expect(getPendingLogin(token)).toBeNull();
  });

  it("a failing second-factor passkey does not log in and counts as an attempt", async () => {
    const u = await createTestUser();
    seedPasskey(u.id);
    const { token } = createPendingLogin(u.id);
    const cookies = { [PENDING_COOKIE]: token };
    await call(
      loginOptions,
      post("/x", { mode: "second_factor" }, { cookies }),
    );
    verifyAuth.mockResolvedValue({ verified: false });
    const event = post("/x", { credential }, { cookies });
    expect((await call(loginVerify, event)).status).toBe(400);
    expect(
      (event.cookies as unknown as FakeCookies).get(SESSION_COOKIE),
    ).toBeUndefined();
    expect(getPendingLogin(token)?.attempts).toBe(1);
    // the challenge was consumed: replaying without new options fails
    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    expect(
      (await call(loginVerify, post("/x", { credential }, { cookies }))).status,
    ).toBe(400);
  });

  it("passkey-only users step up with password plus a fresh assertion", async () => {
    const u = await createTestUser();
    seedPasskey(u.id);
    const s = sess(u, null);
    const opts = await call(stepupOptions, post("/x", {}, s));
    expect(opts.status).toBe(200);

    verifyAuth.mockResolvedValue({ verified: false });
    const badAssertion = await call(
      stepupVerify,
      post(
        "/x",
        {
          challengeId: opts.body.challengeId,
          password: u.password,
          credential,
        },
        s,
      ),
    );
    expect(badAssertion.status).toBe(400);
    expect(hasRecentReauth(s.session.id)).toBe(false);

    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    const fresh = await call(stepupOptions, post("/x", {}, s));
    const badPassword = await call(
      stepupVerify,
      post(
        "/x",
        {
          challengeId: fresh.body.challengeId,
          password: "wrong-wrong-wrong",
          credential,
        },
        s,
      ),
    );
    expect(badPassword.status).toBe(400);
    expect(hasRecentReauth(s.session.id)).toBe(false);

    const again = await call(stepupOptions, post("/x", {}, s));
    const ok = await call(
      stepupVerify,
      post(
        "/x",
        {
          challengeId: again.body.challengeId,
          password: u.password,
          credential,
        },
        s,
      ),
    );
    expect(ok).toMatchObject({ status: 200, body: { reauthed: true } });
    expect(hasRecentReauth(s.session.id)).toBe(true);
  });

  it("step-up challenges are single-use and bound to the caller", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    seedPasskey(u.id);
    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    const opts = await call(stepupOptions, post("/x", {}, sess(u, null)));
    const o = sess(other, null);
    const stolen = await call(
      stepupVerify,
      post(
        "/x",
        {
          challengeId: opts.body.challengeId,
          password: other.password,
          credential,
        },
        o,
      ),
    );
    expect(stolen.status).toBe(400);
    expect(hasRecentReauth(o.session.id)).toBe(false);
    const s = sess(u, null);
    const replay = await call(
      stepupVerify,
      post(
        "/x",
        {
          challengeId: opts.body.challengeId,
          password: u.password,
          credential,
        },
        s,
      ),
    );
    expect(replay.status).toBe(400);
  });

  it("users with an authenticator app must use a code, not the passkey path", async () => {
    const u = await createTestUser();
    seedPasskey(u.id);
    const { startTotpEnrolment, confirmTotpEnrolment } =
      await import("$lib/server/auth/two-factor");
    const { totpCode } = await import("$lib/server/auth/totp");
    const { secret } = startTotpEnrolment(u.id, u.username);
    confirmTotpEnrolment(u.id, totpCode(secret, Date.now()));
    expect(
      (await call(stepupOptions, post("/x", {}, sess(u, null)))).status,
    ).toBe(400);
  });

  it("rate limits unauthenticated passkey login options per address", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await call(loginOptions, post("/x", { mode: "passwordless" })))
        .status;
    }
    expect(last).toBe(429);
    const other = await call(
      loginOptions,
      post("/x", { mode: "passwordless" }, { ip: "198.51.100.9" }),
    );
    expect(other.status).toBe(200);
  });
});
