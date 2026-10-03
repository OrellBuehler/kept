import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_COOKIE,
  createPendingLogin,
  getPendingLogin,
} from "$lib/server/auth/challenges";
import {
  passkeyLoginLimiter,
  secondFactorLimiter,
} from "$lib/server/auth/rate-limit";
import {
  SESSION_COOKIE,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent } from "$lib/testing/event";
import { getDB, passkeys } from "$lib/server/db";

const verifyReg = vi.fn();
const verifyAuth = vi.fn();
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: (o: unknown) => verifyReg(o),
  verifyAuthenticationResponse: (o: unknown) => verifyAuth(o),
}));

const { POST: registerOptions } = await import("./register/options/+server");
const { POST: registerVerify } = await import("./register/verify/+server");
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
      { user: u, headers: { origin: ORIGIN, "content-type": "text/plain" } },
    );
    expect((await call(registerOptions, wrongType)).status).toBe(415);
    const bad = post("/x", { nope: 1 }, { user: u });
    expect((await call(registerVerify, bad)).status).toBe(400);
  });

  it("registers a passkey: challenge is single-use and bound to the user", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const opts = await call(registerOptions, post("/x", {}, { user: u }));
    expect(opts.status).toBe(200);
    const { challengeId } = opts.body;

    const wrongUser = await call(
      registerVerify,
      post("/x", { challengeId, name: "n", credential }, { user: other }),
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
      post("/x", { challengeId, name: "n", credential }, { user: u }),
    );
    expect(replay.status).toBe(400);

    const fresh = await call(registerOptions, post("/x", {}, { user: u }));
    const ok = await call(
      registerVerify,
      post(
        "/x",
        { challengeId: fresh.body.challengeId, name: "Laptop", credential },
        { user: u },
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
});
