import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { RateLimitedError, authenticate } from "./login";
import { LoginRateLimiter } from "./rate-limit";
import { validateSessionToken } from "./sessions";

describe("authenticate", () => {
  useTestDB();

  it("logs in with correct credentials and creates a session", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    const r = await authenticate("alice", u.password, "1.1.1.1", limiter);
    expect(r?.user.id).toBe(u.id);
    expect(validateSessionToken(r!.token)?.user.id).toBe(u.id);
  });

  it("returns null for a wrong password and for an unknown user alike", async () => {
    await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    expect(
      await authenticate("alice", "wrong-password", "1.1.1.1", limiter),
    ).toBeNull();
    expect(
      await authenticate("ghost", "wrong-password", "1.1.1.1", limiter),
    ).toBeNull();
  });

  it("counts failures for unknown usernames too, then blocks", async () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) {
      await authenticate("ghost", "wrong-password", "1.1.1.1", limiter);
    }
    await expect(
      authenticate("ghost", "wrong-password", "1.1.1.1", limiter),
    ).rejects.toThrow(/try again in 15 minutes/);
  });

  it("blocks even the correct password while rate limited", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) {
      await authenticate("alice", "wrong-password", "1.1.1.1", limiter);
    }
    await expect(
      authenticate("alice", u.password, "1.1.1.1", limiter),
    ).rejects.toBeInstanceOf(RateLimitedError);
    // a different client address is unaffected
    expect(
      await authenticate("alice", u.password, "2.2.2.2", limiter),
    ).not.toBeNull();
  });

  it("a successful login resets the username counter", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 4; i++) {
      await authenticate("alice", "wrong-password", "1.1.1.1", limiter);
    }
    await authenticate("alice", u.password, "1.1.1.1", limiter);
    for (let i = 0; i < 4; i++) {
      await authenticate("alice", "wrong-password", "1.1.1.1", limiter);
    }
    expect(
      await authenticate("alice", u.password, "1.1.1.1", limiter),
    ).not.toBeNull();
  });
});
