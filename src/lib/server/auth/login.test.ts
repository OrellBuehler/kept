import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  RateLimitedError,
  authenticate,
  clientKey,
  resetAddressWarnings,
  warnIfAddressHeaderUnset,
  warnIfProxied,
} from "./login";
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

  it("many failures on a username from other clients never lock out the owner", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    for (let i = 0; i < 25; i++) {
      await authenticate(
        "alice",
        "wrong-password",
        `10.0.0.${i}`,
        limiter,
        Date.now(),
        sleep,
      );
    }
    const r = await authenticate(
      "alice",
      u.password,
      "9.9.9.9",
      limiter,
      Date.now(),
      sleep,
    );
    if (!r || !("user" in r)) throw new Error("expected a full login");
    expect(r.user.id).toBe(u.id);
    expect(slept.length).toBeGreaterThan(0);
    expect(slept.at(-1)).toBeGreaterThan(0);
  });

  it("an exhausted username+ip budget is still enforced", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) {
      await authenticate("alice", "wrong-password", "6.6.6.6", limiter);
    }
    await expect(
      authenticate("alice", u.password, "6.6.6.6", limiter),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("warns once about a missing ADDRESS_HEADER at startup and on proxy headers", () => {
    resetAddressWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfAddressHeaderUnset({});
    expect(warn).toHaveBeenCalledTimes(1);
    warnIfAddressHeaderUnset({ ADDRESS_HEADER: "x-forwarded-for" });
    expect(warn).toHaveBeenCalledTimes(1);

    const plain = new Headers();
    const proxied = new Headers({ "x-forwarded-for": "203.0.113.5" });
    warnIfProxied(plain, {});
    expect(warn).toHaveBeenCalledTimes(1);
    warnIfProxied(proxied, { ADDRESS_HEADER: "x-forwarded-for" });
    expect(warn).toHaveBeenCalledTimes(1);
    warnIfProxied(proxied, {});
    warnIfProxied(proxied, {});
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    resetAddressWarnings();
  });
});
