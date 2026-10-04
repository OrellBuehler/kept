import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { authEvents, getDB, passkeys, totpCredentials } from "$lib/server/db";
import { decryptSecret } from "$lib/server/crypto";
import { LoginRateLimiter } from "./rate-limit";
import { validateSessionToken } from "./sessions";
import { totpCode } from "./totp";
import {
  RECOVERY_CODE_COUNT,
  confirmTotpEnrolment,
  consumeRecoveryCode,
  consumeTotpCode,
  disableTotp,
  getPendingTotpEnrolment,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  reauthenticate,
  reauthenticatePasswordOnly,
  resetTwoFactor,
  startTotpEnrolment,
  verifySecondFactorCode,
} from "./two-factor";
import { AuthError } from "./types";

const NOW = 1_700_000_000_000;

async function enrol(userId: string, username: string, now = NOW) {
  const { secret } = startTotpEnrolment(userId, username);
  const codes = confirmTotpEnrolment(userId, totpCode(secret, now), now);
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
    const { secret } = startTotpEnrolment(u.id, u.username);
    const row = getDB()
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, u.id))
      .get()!;
    expect(row.secret).not.toContain(secret);
    expect(decryptSecret(row.secret)).toBe(secret);
    expect(getTwoFactorStatus(u.id).enabled).toBe(false);
    expect(consumeTotpCode(u.id, totpCode(secret, NOW), NOW)).toBe(false);

    expect(() => confirmTotpEnrolment(u.id, "000000", NOW)).toThrow(AuthError);
    expect(getTwoFactorStatus(u.id).enabled).toBe(false);

    const codes = confirmTotpEnrolment(u.id, totpCode(secret, NOW), NOW);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(getTwoFactorStatus(u.id)).toMatchObject({
      totpEnabled: true,
      enabled: true,
      recoveryCodesRemaining: RECOVERY_CODE_COUNT,
    });
  });

  it("refuses to restart enrolment while enabled", async () => {
    const u = await createTestUser();
    await enrol(u.id, u.username);
    expect(() => startTotpEnrolment(u.id, u.username)).toThrow(AuthError);
  });

  it("accepts a code once per time step (replay)", async () => {
    const u = await createTestUser();
    const { secret } = await enrol(u.id, u.username);
    // the confirmation consumed the current step
    expect(consumeTotpCode(u.id, totpCode(secret, NOW), NOW)).toBe(false);
    const next = NOW + 30_000;
    expect(consumeTotpCode(u.id, totpCode(secret, next), next)).toBe(true);
    expect(consumeTotpCode(u.id, totpCode(secret, next), next)).toBe(false);
  });

  it("recovery codes work exactly once and ignore formatting", async () => {
    const u = await createTestUser();
    const { codes } = await enrol(u.id, u.username);
    expect(codes[0]).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(consumeRecoveryCode(u.id, codes[0].toUpperCase())).toBe(true);
    expect(consumeRecoveryCode(u.id, codes[0])).toBe(false);
    expect(consumeRecoveryCode(u.id, "aaaa-aaaa-aaaa-aaaa")).toBe(false);
    expect(getTwoFactorStatus(u.id).recoveryCodesRemaining).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });

  it("recovery codes are stored hashed and cannot be used by another user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { codes } = await enrol(a.id, a.username);
    await enrol(b.id, b.username);
    const stored = getDB()
      .select()
      .from((await import("$lib/server/db")).recoveryCodes)
      .all();
    for (const row of stored) {
      expect(codes.map((c) => c.replace(/-/g, ""))).not.toContain(row.codeHash);
    }
    expect(verifySecondFactorCode(b.id, codes[1])).toBe(false);
    expect(verifySecondFactorCode(a.id, codes[1])).toBe(true);
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
    expect(consumeRecoveryCode(u.id, codes[0])).toBe(false);
    expect(consumeRecoveryCode(u.id, fresh[0])).toBe(true);
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
    expect(getTwoFactorStatus(u.id).totpEnabled).toBe(true);
    await disableTotp(u.id, u.password, good, limiter, next);
    expect(getTwoFactorStatus(u.id).totpEnabled).toBe(false);
  });

  it("disabling with password and a recovery code removes everything", async () => {
    const u = await createTestUser();
    const { codes } = await enrol(u.id, u.username);
    await disableTotp(u.id, u.password, codes[0], limiter);
    expect(getTwoFactorStatus(u.id)).toMatchObject({
      totpEnabled: false,
      enabled: false,
      recoveryCodesRemaining: 0,
    });
    const types = getDB()
      .select()
      .from(authEvents)
      .all()
      .map((e) => e.type);
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
    getDB()
      .insert(passkeys)
      .values({
        userId: u.id,
        name: "k",
        credentialId: "cred",
        publicKey: "pk",
        deviceType: "singleDevice",
        backedUp: false,
      })
      .run();
    const s = loginTestUser(u);

    resetTwoFactor(admin.id, u.id);

    expect(getTwoFactorStatus(u.id)).toMatchObject({
      enabled: false,
      passkeyCount: 0,
    });
    expect(validateSessionToken(s.token)).toBeNull();
    const event = getDB()
      .select()
      .from(authEvents)
      .where(eq(authEvents.type, "two_factor_reset"))
      .get()!;
    expect(event).toMatchObject({ userId: u.id, actorId: admin.id });
    expect(() => resetTwoFactor(admin.id, "missing")).toThrow(AuthError);
  });

  it("resetTwoFactor changes nothing when the audit write fails", async () => {
    const admin = await createTestUser({ role: "admin" });
    const u = await createTestUser();
    await enrol(u.id, u.username);
    const s = loginTestUser(u);
    expect(() =>
      resetTwoFactor(admin.id, u.id, undefined, () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(getTwoFactorStatus(u.id).totpEnabled).toBe(true);
    expect(validateSessionToken(s.token)).not.toBeNull();
    expect(
      getDB()
        .select()
        .from(authEvents)
        .all()
        .some((e) => e.type === "two_factor_reset"),
    ).toBe(false);
  });

  it("passkey-only users cannot pass the password+code reauthentication", async () => {
    const u = await createTestUser();
    getDB()
      .insert(passkeys)
      .values({
        userId: u.id,
        name: "k",
        credentialId: "c",
        publicKey: "pk",
        deviceType: "singleDevice",
        backedUp: false,
      })
      .run();
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
    startTotpEnrolment(u.id, u.username);
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getPendingTotpEnrolment(u.id, u.username)).toBeNull();
    expect(() => startTotpEnrolment(u.id, u.username)).not.toThrow();
    expect(getPendingTotpEnrolment(u.id, u.username)).not.toBeNull();
  });

  it("authenticator codes are rejected but recovery codes still work", async () => {
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
    const u = await createTestUser();
    const { secret } = startTotpEnrolment(u.id, u.username);
    const codes = confirmTotpEnrolment(u.id, totpCode(secret, NOW), NOW);
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      verifySecondFactorCode(
        u.id,
        totpCode(secret, NOW + 60_000),
        NOW + 60_000,
      ),
    ).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(verifySecondFactorCode(u.id, codes[0], NOW)).toBe(true);
  });
});
