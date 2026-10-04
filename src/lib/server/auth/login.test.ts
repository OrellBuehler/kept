import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  RateLimitedError,
  authenticate,
  clientKey,
  normalizeClientAddress,
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

  it("keys IPv6 clients on their /64 and unwraps IPv4-mapped addresses", () => {
    expect(normalizeClientAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeClientAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeClientAddress("::ffff:cb00:7109")).toBe("203.0.113.9");
    const a = normalizeClientAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(normalizeClientAddress("2001:0DB8:1:2::9")).toBe(a);
    expect(normalizeClientAddress("2001:db8:1:3::9")).not.toBe(a);
    expect(normalizeClientAddress("fe80::1%eth0")).toBe(
      normalizeClientAddress("fe80::2"),
    );
    expect(normalizeClientAddress("not an address")).toBe("not an address");
  });

  it("rotating addresses inside one /64 share a single username+address budget", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) {
      const ip = clientKey(() => `2001:db8:7:7:${i}::${i + 1}`);
      await authenticate("alice", "wrong-password", ip, limiter);
    }
    await expect(
      authenticate(
        "alice",
        u.password,
        clientKey(() => "2001:db8:7:7:ffff::1"),
        limiter,
      ),
    ).rejects.toBeInstanceOf(RateLimitedError);
    const other = await authenticate(
      "alice",
      u.password,
      clientKey(() => "2001:db8:7:8::1"),
      new LoginRateLimiter(),
    );
    expect(other).not.toBeNull();
  });

  describe("per-username throttle", () => {
    function tracker() {
      let running = 0;
      let peak = 0;
      const sleeps: number[] = [];
      const sleep = async (ms: number) => {
        running++;
        peak = Math.max(peak, running);
        sleeps.push(ms);
        await Bun.sleep(2);
        running--;
      };
      return { sleep, sleeps, peak: () => peak };
    }

    it("serialises and caps a parallel burst from rotating addresses", async () => {
      await createTestUser({ username: "alice" });
      const limiter = new LoginRateLimiter();
      const t = tracker();
      const results = await Promise.allSettled(
        Array.from({ length: 60 }, (_, i) =>
          authenticate(
            "alice",
            "wrong-password",
            `10.1.${i >> 8}.${i & 255}`,
            limiter,
            Date.now(),
            t.sleep,
          ),
        ),
      );
      const rejected = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof RateLimitedError,
      );
      // 10 free attempts + 3 queued behind the backoff; everything else is turned away
      expect(results.length - rejected.length).toBe(13);
      expect(rejected).toHaveLength(47);
      expect(t.sleeps).toHaveLength(3);
      expect(t.peak()).toBe(1);
    });

    it("caps queued attempts across usernames globally", async () => {
      const limiter = new LoginRateLimiter(
        Date.now,
        undefined,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        { maxQueuedGlobal: 4, maxQueuedPerUser: 3 },
      );
      const t = tracker();
      const names = ["aa1", "aa2", "aa3"];
      const results = await Promise.allSettled(
        names.flatMap((n, ni) =>
          Array.from({ length: 3 }, (_, i) =>
            authenticate(
              n,
              "wrong-password",
              `10.2.${ni}.${i}`,
              limiter,
              Date.now(),
              t.sleep,
            ),
          ),
        ),
      );
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(5);
      expect(t.sleeps).toHaveLength(4);
    });

    it("the owner with the right password still gets in, after a bounded wait", async () => {
      const u = await createTestUser({ username: "alice" });
      const limiter = new LoginRateLimiter();
      const t = tracker();
      for (let i = 0; i < 25; i++) {
        await authenticate(
          "alice",
          "wrong-password",
          `10.3.0.${i}`,
          limiter,
          Date.now(),
          t.sleep,
        );
      }
      t.sleeps.length = 0;
      const attackers = Array.from({ length: 2 }, (_, i) =>
        authenticate(
          "alice",
          "wrong-password",
          `10.3.1.${i}`,
          limiter,
          Date.now(),
          t.sleep,
        ),
      );
      const r = await authenticate(
        "alice",
        u.password,
        "9.9.9.9",
        limiter,
        Date.now(),
        t.sleep,
      );
      await Promise.all(attackers);
      if (!r || !("user" in r)) throw new Error("expected a full login");
      expect(r.user.id).toBe(u.id);
      expect(t.sleeps).toHaveLength(3);
      expect(t.peak()).toBe(1);
    });

    it("frees the queue slot once each attempt finishes", async () => {
      await createTestUser({ username: "alice" });
      const limiter = new LoginRateLimiter();
      const t = tracker();
      for (let i = 0; i < 40; i++) {
        await authenticate(
          "alice",
          "wrong-password",
          `10.4.0.${i}`,
          limiter,
          Date.now(),
          t.sleep,
        );
      }
      expect(limiter.reserve("alice", "10.4.9.9").delayMs).toBeGreaterThan(0);
    });

    it("treats an oversized username like any unknown user", async () => {
      const limiter = new LoginRateLimiter();
      const r = await authenticate(
        "a".repeat(33),
        "wrong-password",
        "1.1.1.1",
        limiter,
      );
      expect(r).toBeNull();
    });
  });
});
