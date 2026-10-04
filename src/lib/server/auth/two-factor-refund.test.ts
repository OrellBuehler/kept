import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  LoginRateLimiter,
  MAX_FAILURES_PER_USER_IP,
  RateLimitedError,
} from "./rate-limit";
import { reauthenticatePasswordOnly } from "./two-factor";

const password = vi.hoisted(() => ({ fail: false }));
vi.mock("./password", async (orig) => {
  const m = await orig<typeof import("./password")>();
  return {
    ...m,
    verifyPassword: async (...args: Parameters<typeof m.verifyPassword>) => {
      if (password.fail) throw new Error("hash backend down");
      return m.verifyPassword(...args);
    },
  };
});

describe("re-authentication limiter", () => {
  useTestDB();
  afterEach(() => {
    password.fail = false;
  });

  it("gives the attempt back when the check fails for a reason other than the credentials", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    password.fail = true;
    for (let i = 0; i < MAX_FAILURES_PER_USER_IP + 2; i++) {
      await expect(
        reauthenticatePasswordOnly(u.id, u.password, limiter),
      ).rejects.toThrow("hash backend down");
    }
    password.fail = false;
    await expect(
      reauthenticatePasswordOnly(u.id, u.password, limiter),
    ).resolves.toBeUndefined();
  });

  it("still counts a wrong password", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < MAX_FAILURES_PER_USER_IP; i++) {
      await expect(
        reauthenticatePasswordOnly(u.id, "wrong-password", limiter),
      ).rejects.toThrow("Password is incorrect.");
    }
    await expect(
      reauthenticatePasswordOnly(u.id, u.password, limiter),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
