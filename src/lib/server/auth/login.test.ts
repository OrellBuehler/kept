import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, enableTotp } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  RateLimitedError,
  authenticate,
  clientKey,
  completeSecondFactor,
  normalizeClientAddress,
  resetAddressWarnings,
  warnIfAddressHeaderUnset,
  warnIfProxied,
} from "./login";
import { MAX_PENDING_ATTEMPTS, createPendingLogin } from "./challenges";
import { LoginRateLimiter, MAX_FAILURES_PER_USER_IP } from "./rate-limit";
import { sessions } from "$lib/server/db";
import { validateSessionToken } from "./sessions";

type VerifyFn = typeof import("./two-factor").verifySecondFactorCode;
const verify = vi.hoisted(() => ({
  real: null as VerifyFn | null,
  calls: 0,
  override: null as VerifyFn | null,
}));
vi.mock("./two-factor", async (orig) => {
  const m = await orig<typeof import("./two-factor")>();
  verify.real = m.verifySecondFactorCode;
  return {
    ...m,
    verifySecondFactorCode: async (...args: Parameters<VerifyFn>) => {
      verify.calls++;
      await new Promise((r) => setTimeout(r, 1));
      return (verify.override ?? m.verifySecondFactorCode)(...args);
    },
  };
});

describe("authenticate", () => {
  useTestDB();

  it("logs in with correct credentials and creates a session", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    const r = await authenticate("alice", u.password, "1.1.1.1", limiter);
    if (!r || !("user" in r)) throw new Error("expected a full login");
    expect(r.user.id).toBe(u.id);
    expect((await validateSessionToken(r.token))?.user.id).toBe(u.id);
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

  it("clientKey strips brackets and ports and maps junk to the shared key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(clientKey(() => "203.0.113.9:51234")).toBe("203.0.113.9");
    expect(clientKey(() => "[2001:db8:1:2::9]:443")).toBe(
      normalizeClientAddress("2001:db8:1:2::9"),
    );
    expect(clientKey(() => "[2001:db8:1:2::9]")).toBe(
      normalizeClientAddress("2001:db8:1:2::9"),
    );
    expect(clientKey(() => "2001:db8:1:2::9")).toBe(
      normalizeClientAddress("2001:db8:1:2::9"),
    );
    const shared = clientKey(() => {
      throw new Error("no address");
    });
    for (const junk of [
      "",
      "unknown",
      "evil\nvalue",
      "x".repeat(10_000),
      "999.1.1.1",
      "1.2.3.4:99999x",
      "[not-an-ip]:80",
      "203.0.113.9, 198.51.100.1",
    ]) {
      expect(clientKey(() => junk)).toBe(shared);
    }
    warn.mockRestore();
    resetAddressWarnings();
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
      for (let i = 0; i < 12; i++) {
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
      for (let i = 0; i < 12; i++) {
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

describe("recent-success bypass", () => {
  useTestDB();

  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  async function pressure(limiter: LoginRateLimiter) {
    for (let i = 0; i < 12; i++) {
      await authenticate("alice", "wrong-password", `10.9.0.${i}`, limiter);
    }
    sleeps.length = 0;
  }

  it("the owner from an address that logged in before skips the backoff", async () => {
    const u = await createTestUser({ username: "alice" });
    const limiter = new LoginRateLimiter();
    await authenticate("alice", u.password, "198.51.100.7", limiter);
    await pressure(limiter);
    const known = await authenticate(
      "alice",
      u.password,
      "198.51.100.7",
      limiter,
      Date.now(),
      sleep,
    );
    expect(known).not.toBeNull();
    expect(sleeps).toEqual([]);
    const unknown = await authenticate(
      "alice",
      u.password,
      "203.0.113.9",
      limiter,
      Date.now(),
      sleep,
    );
    expect(unknown).not.toBeNull();
    expect(sleeps).toHaveLength(1);
  });

  it("a password-only step of a 2FA user does not make the address known", async () => {
    const u = await createTestUser({ username: "alice" });
    await enableTotp(u);
    const limiter = new LoginRateLimiter();
    const step = await authenticate(
      "alice",
      u.password,
      "198.51.100.7",
      limiter,
    );
    expect(step).toMatchObject({ secondFactorRequired: true });
    await pressure(limiter);
    await authenticate(
      "alice",
      u.password,
      "198.51.100.7",
      limiter,
      Date.now(),
      sleep,
    );
    expect(sleeps).toHaveLength(1);
  });

  it("completing the second factor makes the address known", async () => {
    const u = await createTestUser({ username: "alice" });
    const [recovery] = await enableTotp(u);
    const limiter = new LoginRateLimiter();
    const second = new LoginRateLimiter();
    const pending = await createPendingLogin(u.id);
    const r = await completeSecondFactor(
      pending.token,
      recovery,
      "198.51.100.7",
      second,
      Date.now(),
      limiter,
    );
    expect(r).not.toBeNull();
    await pressure(limiter);
    await authenticate(
      "alice",
      u.password,
      "198.51.100.7",
      limiter,
      Date.now(),
      sleep,
    );
    expect(sleeps).toEqual([]);
  });

  it("a wrong second-factor code leaves the address unknown", async () => {
    const u = await createTestUser({ username: "alice" });
    await enableTotp(u);
    const limiter = new LoginRateLimiter();
    const pending = await createPendingLogin(u.id);
    const r = await completeSecondFactor(
      pending.token,
      "000000",
      "198.51.100.7",
      new LoginRateLimiter(),
      Date.now(),
      limiter,
    );
    expect(r).toBeNull();
    await pressure(limiter);
    await authenticate(
      "alice",
      u.password,
      "198.51.100.7",
      limiter,
      Date.now(),
      sleep,
    );
    expect(sleeps).toHaveLength(1);
  });
});

describe("completeSecondFactor under parallel requests", () => {
  const ctx = useTestDB();

  beforeEach(() => {
    verify.calls = 0;
    verify.override = null;
  });
  afterEach(() => {
    verify.override = null;
  });

  it("verifies at most MAX_PENDING_ATTEMPTS of many parallel wrong codes from different addresses", async () => {
    const u = await createTestUser({ username: "alice" });
    await enableTotp(u);
    const pending = await createPendingLogin(u.id);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        completeSecondFactor(
          pending.token,
          "000000",
          `198.51.100.${i + 1}`,
          new LoginRateLimiter(),
        ),
      ),
    );
    expect(verify.calls).toBe(MAX_PENDING_ATTEMPTS);
    const wrong = results.filter(
      (r) => r.status === "fulfilled" && r.value === null,
    );
    expect(wrong).toHaveLength(MAX_PENDING_ATTEMPTS);
    const expired = results.filter(
      (r) =>
        r.status === "rejected" &&
        (r.reason as { code?: string }).code === "pending_expired",
    );
    expect(expired).toHaveLength(10 - MAX_PENDING_ATTEMPTS);
  });

  it("a correct code arriving after the cap is spent is refused unverified", async () => {
    const u = await createTestUser({ username: "alice" });
    const [recovery] = await enableTotp(u);
    const pending = await createPendingLogin(u.id);
    for (let i = 0; i < MAX_PENDING_ATTEMPTS; i++) {
      await completeSecondFactor(
        pending.token,
        "000000",
        `198.51.100.${i + 1}`,
        new LoginRateLimiter(),
      );
    }
    verify.calls = 0;
    await expect(
      completeSecondFactor(
        pending.token,
        recovery,
        "198.51.100.99",
        new LoginRateLimiter(),
      ),
    ).rejects.toMatchObject({ code: "pending_expired" });
    expect(verify.calls).toBe(0);
  });

  it("two parallel valid factors mint one session", async () => {
    const u = await createTestUser({ username: "alice" });
    const [first, second] = await enableTotp(u);
    const pending = await createPendingLogin(u.id);
    const results = await Promise.allSettled(
      [first, second].map((code, i) =>
        completeSecondFactor(
          pending.token,
          code,
          `198.51.100.${i + 1}`,
          new LoginRateLimiter(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost).toMatchObject({
      reason: { code: "pending_expired" },
    });
    expect(await ctx.db.select().from(sessions)).toHaveLength(1);
  });

  it("gives the limiter slot back when verification throws", async () => {
    const u = await createTestUser({ username: "alice" });
    await enableTotp(u);
    const limiter = new LoginRateLimiter();
    verify.override = async () => {
      throw new Error("db down");
    };
    for (let i = 0; i < MAX_FAILURES_PER_USER_IP + 2; i++) {
      const pending = await createPendingLogin(u.id);
      await expect(
        completeSecondFactor(pending.token, "000000", "198.51.100.1", limiter),
      ).rejects.toThrow("db down");
    }
    verify.override = null;
    const second = await createPendingLogin(u.id);
    expect(
      await completeSecondFactor(
        second.token,
        "000000",
        "198.51.100.1",
        limiter,
      ),
    ).toBeNull();
  });
});
