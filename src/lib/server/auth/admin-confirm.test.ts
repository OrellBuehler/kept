import { describe, expect, it } from "vitest";
import { addPasskey, createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { LoginRateLimiter } from "./rate-limit";
import { totpCode } from "./totp";
import {
  confirmTotpEnrolment,
  markSessionReauthenticated,
  startTotpEnrolment,
} from "./two-factor";
import { createSession } from "./sessions";
import {
  DOWNLOAD_TOKEN_TTL_MS,
  adminConfirmMode,
  confirmAdmin,
  consumeDownloadToken,
  issueDownloadToken,
} from "./admin-confirm";

describe("download tokens", () => {
  it("work once, for their user, within the ttl", () => {
    const t = issueDownloadToken("u1", 1000);
    expect(consumeDownloadToken(t, "u1", 1000 + 1)).toBe(true);
    expect(consumeDownloadToken(t, "u1", 1000 + 1)).toBe(false);
  });

  it("are refused for another user and burnt by the attempt", () => {
    const t = issueDownloadToken("u1", 1000);
    expect(consumeDownloadToken(t, "u2", 1001)).toBe(false);
    expect(consumeDownloadToken(t, "u1", 1001)).toBe(false);
  });

  it("expire", () => {
    const t = issueDownloadToken("u1", 1000);
    expect(consumeDownloadToken(t, "u1", 1000 + DOWNLOAD_TOKEN_TTL_MS)).toBe(
      false,
    );
  });

  it("reject missing and unknown tokens", () => {
    expect(consumeDownloadToken(null, "u1")).toBe(false);
    expect(consumeDownloadToken("nope", "u1")).toBe(false);
  });
});

describe("confirmAdmin", () => {
  useTestDB();
  const NOW = 1_700_000_000_000;

  it("password only without a second factor", async () => {
    const u = await createTestUser({ role: "admin" });
    const limiter = new LoginRateLimiter();
    await expect(
      confirmAdmin(u.id, undefined, { password: u.password }, limiter, NOW),
    ).resolves.toBeUndefined();
    await expect(
      confirmAdmin(
        u.id,
        undefined,
        { password: "wrong-password-x" },
        limiter,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(adminConfirmMode(u.id)).toBe("password");
  });

  it("with an authenticator app it needs password and a current code", async () => {
    const u = await createTestUser({ role: "admin" });
    const { secret } = startTotpEnrolment(u.id, u.username);
    confirmTotpEnrolment(u.id, totpCode(secret, NOW), NOW);
    const limiter = new LoginRateLimiter();
    const later = NOW + 30_000;

    await expect(
      confirmAdmin(u.id, undefined, { password: u.password }, limiter, later),
    ).rejects.toMatchObject({ code: "invalid_code" });
    await expect(
      confirmAdmin(
        u.id,
        undefined,
        { password: "wrong-password-x", code: totpCode(secret, later) },
        limiter,
        later,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(
      confirmAdmin(
        u.id,
        undefined,
        { password: u.password, code: totpCode(secret, later) },
        limiter,
        later,
      ),
    ).resolves.toBeUndefined();
    expect(adminConfirmMode(u.id)).toBe("totp");
  });

  it("a passkey-only admin needs a recent passkey step-up on the session", async () => {
    const u = await createTestUser({ role: "admin" });
    addPasskey(u.id);
    const { session } = createSession(u.id);
    const limiter = new LoginRateLimiter();
    await expect(
      confirmAdmin(u.id, session.id, { password: u.password }, limiter, NOW),
    ).rejects.toMatchObject({ code: "passkey_required" });
    markSessionReauthenticated(u.id, session.id, NOW);
    await expect(
      confirmAdmin(
        u.id,
        session.id,
        { password: u.password },
        limiter,
        NOW + 1000,
      ),
    ).resolves.toBeUndefined();
    // the step-up expires
    await expect(
      confirmAdmin(
        u.id,
        session.id,
        { password: u.password },
        limiter,
        NOW + 10 * 60_000,
      ),
    ).rejects.toMatchObject({ code: "passkey_required" });
    expect(adminConfirmMode(u.id)).toBe("passkey");
  });
});
