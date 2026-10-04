import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { RateLimitedError, authenticate, clientKey } from "./login";
import { LoginRateLimiter } from "./rate-limit";
import { validateSessionToken } from "./sessions";

describe("authenticate", () => {
  useTestDB();

  it("logs in with correct credentials and creates a session", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    const r = await authenticate("alice", u.password, "1.1.1.1", limiter);
    if (!r || !("user" in r)) throw new Error("expected a full login");
    expect(r.user.id).toBe(u.id);
    expect(validateSessionToken(r.token)?.user.id).toBe(u.id);
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

  it("counts parallel guesses: most of 10 concurrent bad logins are rate limited", async () => {
    await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        authenticate("alice", "wrong-password", "1.1.1.1", limiter),
      ),
    );
    const limited = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof RateLimitedError,
    );
    expect(limited).toHaveLength(5);
  });

  it("clientKey falls back to a fixed key when the address is unavailable", () => {
    const boom = () => {
      throw new Error("no address");
    };
    expect(clientKey(boom)).toBe("unknown");
    expect(clientKey(() => "1.2.3.4")).toBe("1.2.3.4");
  });
});
