import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  authEvents,
  first,
  getDB,
  passkeys,
  totpCredentials,
} from "$lib/server/db";
import { decryptSecret } from "$lib/server/crypto";
import { LoginRateLimiter } from "./rate-limit";
import { validateSessionToken } from "./sessions";
import * as totp from "./totp";
import { totpCode } from "./totp";
import {
  RECOVERY_CODE_COUNT,
  confirmTotpEnrolment,
  consumeRecoveryCode,
  consumeTotpCode,
  disableTotp,
  getPendingTotpEnrolment,
  getTwoFactorStatus,
  hasRecentReauth,
  markSessionReauthenticated,
  regenerateRecoveryCodes,
  reauthenticate,
  reauthenticatePasswordOnly,
  resetTwoFactor,
  startTotpEnrolment,
  usersWithTwoFactor,
  verifySecondFactorCode,
} from "./two-factor";
import { AuthError } from "./types";

const NOW = 1_700_000_000_000;

async function enrol(userId: string, username: string, now = NOW) {
  const { secret } = await startTotpEnrolment(userId, username);
  const codes = await confirmTotpEnrolment(userId, totpCode(secret, now), now);
  return { secret, codes };
}

describe("two-factor", () => {
  useTestDB();
  let limiter: LoginRateLimiter;
  beforeEach(() => {
    limiter = new LoginRateLimiter();
  });

  it("stores the secret encrypted and only protects login once confirmed", async () => {
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const row = (await first(
      getDB()
        .select()
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, u.id))
        .limit(1),
    ))!;
    expect(row.secret).not.toContain(secret);
    expect(decryptSecret(row.secret)).toBe(secret);
    expect((await getTwoFactorStatus(u.id)).enabled).toBe(false);
    expect(await consumeTotpCode(u.id, totpCode(secret, NOW), NOW)).toBe(false);

    await expect(confirmTotpEnrolment(u.id, "000000", NOW)).rejects.toThrow(
      AuthError,
    );
    expect((await getTwoFactorStatus(u.id)).enabled).toBe(false);

    const codes = await confirmTotpEnrolment(u.id, totpCode(secret, NOW), NOW);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(await getTwoFactorStatus(u.id)).toMatchObject({
      totpEnabled: true,
      enabled: true,
      recoveryCodesRemaining: RECOVERY_CODE_COUNT,
    });
  });

  it("refuses to restart enrolment while enabled", async () => {
    const u = await createTestUser();
    await enrol(u.id, u.username);
    await expect(startTotpEnrolment(u.id, u.username)).rejects.toThrow(
      AuthError,
    );
  });

  it("accepts one of many parallel attempts with the same code", async () => {
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const code = totpCode(secret, NOW);
    // Every attempt reads the credential before any has written: only the
    // compare-and-set on the stored step lets exactly one through.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeTotpCode(u.id, code, NOW, { confirming: true }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getTwoFactorStatus(u.id)).toMatchObject({ totpEnabled: true });
  });

  it("rejects a valid code when the step moved between the read and the write", async () => {
    const u = await createTestUser();
    const { secret } = await enrol(u.id, u.username);
    const next = NOW + 30_000;
    const real = totp.verifyTotp;
    const spy = vi.spyOn(totp, "verifyTotp").mockImplementation((...args) => {
      const step = real(...args);
      // A competing attempt records a later step right after the read.
      void getDB()
        .update(totpCredentials)
        .set({ lastStep: 9_999_999_999 })
        .where(eq(totpCredentials.userId, u.id))
        .then(() => undefined);
      return step;
    });
    expect(await consumeTotpCode(u.id, totpCode(secret, next), next)).toBe(
      false,
    );
    spy.mockRestore();
    const row = (await first(
      getDB()
        .select({ lastStep: totpCredentials.lastStep })
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, u.id))
        .limit(1),
    ))!;
    expect(row.lastStep).toBe(9_999_999_999);
  });

  it("accepts a code once per time step (replay)", async () => {
    const u = await createTestUser();
    const { secret } = await enrol(u.id, u.username);
    // the confirmation consumed the current step
    expect(await consumeTotpCode(u.id, totpCode(secret, NOW), NOW)).toBe(false);
    const next = NOW + 30_000;
    expect(await consumeTotpCode(u.id, totpCode(secret, next), next)).toBe(
      true,
    );
    expect(await consumeTotpCode(u.id, totpCode(secret, next), next)).toBe(
      false,
    );
  });

  it("recovery codes work exactly once and ignore formatting", async () => {
    const u = await createTestUser();
    const { codes } = await enrol(u.id, u.username);
    expect(codes[0]).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(await consumeRecoveryCode(u.id, codes[0].toUpperCase())).toBe(true);
    expect(await consumeRecoveryCode(u.id, codes[0])).toBe(false);
    expect(await consumeRecoveryCode(u.id, "aaaa-aaaa-aaaa-aaaa")).toBe(false);
    expect((await getTwoFactorStatus(u.id)).recoveryCodesRemaining).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });

  it("recovery codes are stored hashed and cannot be used by another user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { codes } = await enrol(a.id, a.username);
    await enrol(b.id, b.username);
    const stored = await getDB()
      .select()
      .from((await import("$lib/server/db")).recoveryCodes);
    for (const row of stored) {
      expect(codes.map((c) => c.replace(/-/g, ""))).not.toContain(row.codeHash);
    }
    expect(await verifySecondFactorCode(b.id, codes[1])).toBe(false);
    expect(await verifySecondFactorCode(a.id, codes[1])).toBe(true);
  });

  it("regenerating replaces all old codes", async () => {
    const u = await createTestUser();
    const { secret, codes } = await enrol(u.id, u.username);
    const next = NOW + 30_000;
    const fresh = await regenerateRecoveryCodes(
      u.id,
      u.password,
      totpCode(secret, next),
      limiter,
      next,
    );
    expect(fresh).toHaveLength(RECOVERY_CODE_COUNT);
    expect(await consumeRecoveryCode(u.id, codes[0])).toBe(false);
    expect(await consumeRecoveryCode(u.id, fresh[0])).toBe(true);
  });

  it("disabling needs the password and a code", async () => {
    const u = await createTestUser();
    const { secret } = await enrol(u.id, u.username);
    const next = NOW + 30_000;
    const good = totpCode(secret, next);
    await expect(
      disableTotp(u.id, "wrong-password-xx", good, limiter),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(
      disableTotp(u.id, u.password, "123456", limiter),
    ).rejects.toMatchObject({ code: "invalid_code" });
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(true);
    await disableTotp(u.id, u.password, good, limiter, next);
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(false);
  });

  it("disabling with password and a recovery code removes everything", async () => {
    const u = await createTestUser();
    const { codes } = await enrol(u.id, u.username);
    await disableTotp(u.id, u.password, codes[0], limiter);
    expect(await getTwoFactorStatus(u.id)).toMatchObject({
      totpEnabled: false,
      enabled: false,
      recoveryCodesRemaining: 0,
    });
    const types = (await getDB().select().from(authEvents)).map((e) => e.type);
    expect(types).toContain("totp_disabled");
  });

  it("rate limits wrong re-authentication attempts", async () => {
    const u = await createTestUser();
    await enrol(u.id, u.username);
    for (let i = 0; i < 5; i++) {
      await expect(
        disableTotp(u.id, "wrong-password-xx", "123456", limiter),
      ).rejects.toBeInstanceOf(AuthError);
    }
    await expect(
      disableTotp(u.id, "wrong-password-xx", "123456", limiter),
    ).rejects.toMatchObject({ name: "RateLimitedError" });
  });

  it("admin reset removes all factors, signs the user out and logs without secrets", async () => {
    const admin = await createTestUser({ role: "admin" });
    const u = await createTestUser();
    await enrol(u.id, u.username);
    await getDB().insert(passkeys).values({
      userId: u.id,
      name: "k",
      credentialId: "cred",
      publicKey: "pk",
      deviceType: "singleDevice",
      backedUp: false,
    });
    const s = await loginTestUser(u);

    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await resetTwoFactor(admin.id, u.id);
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({
        event: "auth.two_factor_reset",
        userId: u.id,
        actorId: admin.id,
      }),
    );
    info.mockRestore();

    expect(await getTwoFactorStatus(u.id)).toMatchObject({
      enabled: false,
      passkeyCount: 0,
    });
    expect(await validateSessionToken(s.token)).toBeNull();
    const event = (await first(
      getDB()
        .select()
        .from(authEvents)
        .where(eq(authEvents.type, "two_factor_reset"))
        .limit(1),
    ))!;
    expect(event).toMatchObject({ userId: u.id, actorId: admin.id });
    await expect(resetTwoFactor(admin.id, "missing")).rejects.toThrow(
      AuthError,
    );
  });

  it("resetTwoFactor changes nothing when the audit write fails", async () => {
    const admin = await createTestUser({ role: "admin" });
    const u = await createTestUser();
    await enrol(u.id, u.username);
    const s = await loginTestUser(u);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(
      resetTwoFactor(admin.id, u.id, undefined, () => {
        throw new Error("audit failed");
      }),
    ).rejects.toThrow("audit failed");
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(true);
    expect(await validateSessionToken(s.token)).not.toBeNull();
    expect(
      (await getDB().select().from(authEvents)).some(
        (e) => e.type === "two_factor_reset",
      ),
    ).toBe(false);
  });

  it("passkey-only users cannot pass the password+code reauthentication", async () => {
    const u = await createTestUser();
    await getDB().insert(passkeys).values({
      userId: u.id,
      name: "k",
      credentialId: "c",
      publicKey: "pk",
      deviceType: "singleDevice",
      backedUp: false,
    });
    await expect(
      reauthenticate(u.id, u.password, "", limiter, NOW),
    ).rejects.toMatchObject({ code: "passkey_required" });
    await expect(
      regenerateRecoveryCodes(u.id, u.password, "", limiter),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      reauthenticatePasswordOnly(u.id, u.password, limiter),
    ).resolves.toBeUndefined();
    await expect(
      reauthenticatePasswordOnly(u.id, "wrong-wrong-wrong", limiter),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("totp users need the code even for reauthentication", async () => {
    const u = await createTestUser();
    await enrol(u.id, u.username);
    await expect(
      reauthenticate(u.id, u.password, "", limiter, NOW),
    ).rejects.toMatchObject({ code: "invalid_code" });
  });
});

describe("totp secrets encrypted with another KEPT_SECRET_KEY", () => {
  useTestDB();
  const keyA = Buffer.alloc(32, 1).toString("base64");
  const keyB = Buffer.alloc(32, 2).toString("base64");
  afterEach(() => vi.unstubAllEnvs());

  it("a pending enrolment reads as not started instead of throwing", async () => {
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
    const u = await createTestUser();
    await startTotpEnrolment(u.id, u.username);
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getPendingTotpEnrolment(u.id, u.username)).toBeNull();
    await expect(startTotpEnrolment(u.id, u.username)).resolves.toBeDefined();
    expect(await getPendingTotpEnrolment(u.id, u.username)).not.toBeNull();
  });

  it("authenticator codes are rejected but recovery codes still work", async () => {
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const codes = await confirmTotpEnrolment(u.id, totpCode(secret, NOW), NOW);
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await verifySecondFactorCode(
        u.id,
        totpCode(secret, NOW + 60_000),
        NOW + 60_000,
      ),
    ).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(await verifySecondFactorCode(u.id, codes[0], NOW)).toBe(true);
  });
});

describe("two-factor data is per user", () => {
  useTestDB();

  it("status, enrolment and the second-factor set never cross users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await enrol(a.id, a.username);
    expect(await getTwoFactorStatus(b.id)).toMatchObject({
      totpEnabled: false,
      enabled: false,
      recoveryCodesRemaining: 0,
    });
    expect(await getPendingTotpEnrolment(b.id, b.username)).toBeNull();
    expect([...(await usersWithTwoFactor())]).toEqual([a.id]);
  });

  it("another user cannot mark someone else's session as re-authenticated", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { session } = await loginTestUser(a);
    await markSessionReauthenticated(b.id, session.id, NOW);
    expect(await hasRecentReauth(session.id, NOW)).toBe(false);
    await markSessionReauthenticated(a.id, session.id, NOW);
    expect(await hasRecentReauth(session.id, NOW)).toBe(true);
  });

  it("confirming an enrolment twice in parallel lets only one through", async () => {
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const results = await Promise.allSettled([
      confirmTotpEnrolment(u.id, totpCode(secret, NOW), NOW),
      confirmTotpEnrolment(u.id, totpCode(secret, NOW + 30_000), NOW + 30_000),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getTwoFactorStatus(u.id)).toMatchObject({
      totpEnabled: true,
      recoveryCodesRemaining: RECOVERY_CODE_COUNT,
    });
  });
});
