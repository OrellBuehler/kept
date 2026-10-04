import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "./rate-limit";

const MIN = 60_000;

function setup() {
  let now = 1_000_000;
  const limiter = new LoginRateLimiter(() => now);
  return {
    limiter,
    advance: (ms: number) => (now += ms),
  };
}

describe("LoginRateLimiter", () => {
  it("allows 5 attempts per username+ip, then blocks with a wait time", () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) {
      expect(limiter.acquire("alice", "1.1.1.1").allowed).toBe(true);
    }
    const r = limiter.acquire("alice", "1.1.1.1");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterMinutes).toBe(15);
  });

  it("does not block other usernames from the same ip or other ips", () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) limiter.acquire("alice", "1.1.1.1");
    expect(limiter.acquire("bob", "1.1.1.1").allowed).toBe(true);
    expect(limiter.acquire("alice", "2.2.2.2").allowed).toBe(true);
  });

  it("blocks an ip after 20 attempts across usernames", () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i++) limiter.acquire(`user${i}`, "1.1.1.1");
    expect(limiter.acquire("fresh", "1.1.1.1").allowed).toBe(false);
    expect(limiter.acquire("fresh", "9.9.9.9").allowed).toBe(true);
  });

  it("never hard-blocks a username across ips; it only adds a growing delay", () => {
    const { limiter } = setup();
    const delays: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = limiter.acquire("alice", `10.0.0.${i}`);
      expect(r.allowed).toBe(true);
      if (r.allowed) delays.push(r.delayMs);
    }
    expect(delays.slice(0, 10).every((d) => d === 0)).toBe(true);
    expect(delays[10]).toBeGreaterThan(0);
    expect(delays[20]).toBeGreaterThan(delays[10]);
    expect(Math.max(...delays)).toBe(5000);
    const other = limiter.acquire("bob", "10.0.1.1");
    expect(other.allowed && other.delayMs).toBe(0);
  });

  it("a client under its own budget still gets in while others hammer the username", () => {
    const { limiter } = setup();
    for (let i = 0; i < 30; i++) limiter.acquire("alice", `10.0.0.${i}`);
    for (let i = 0; i < 5; i++) limiter.acquire("alice", "6.6.6.6");
    expect(limiter.acquire("alice", "6.6.6.6").allowed).toBe(false);
    expect(limiter.acquire("alice", "7.7.7.7").allowed).toBe(true);
  });

  it("the backoff ages out with the window", () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 30; i++) limiter.acquire("alice", `10.0.0.${i}`);
    advance(16 * MIN);
    const r = limiter.acquire("alice", "10.0.9.9");
    expect(r.allowed && r.delayMs).toBe(0);
  });

  it("a successful login refunds one failure on the username counter", () => {
    const { limiter } = setup();
    for (let i = 0; i < 10; i++) limiter.acquire("alice", `10.0.0.${i}`);
    const ok = limiter.acquire("alice", "10.0.5.5");
    if (!ok.allowed) throw new Error("expected allowed");
    expect(ok.delayMs).toBeGreaterThan(0);
    ok.release();
    const next = limiter.acquire("alice", "10.0.5.6");
    expect(next.allowed && next.delayMs).toBe(ok.delayMs);
  });

  it("slides: attempts age out of the window", () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i++) {
      limiter.acquire("alice", "1.1.1.1");
      advance(MIN);
    }
    const blocked = limiter.acquire("alice", "1.1.1.1");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMinutes).toBe(10);
    advance(10 * MIN);
    expect(limiter.acquire("alice", "1.1.1.1").allowed).toBe(true);
  });

  it("release refunds the reservation and clears the username+ip counter", () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i++) limiter.acquire("alice", "1.1.1.1");
    const last = limiter.acquire("alice", "1.1.1.1");
    if (!last.allowed) throw new Error("expected allowed");
    last.release();
    for (let i = 0; i < 4; i++) {
      expect(limiter.acquire("alice", "1.1.1.1").allowed).toBe(true);
    }
  });

  it("release does not refund other reservations on the ip counter", () => {
    const { limiter } = setup();
    for (let i = 0; i < 19; i++) limiter.acquire(`user${i}`, "1.1.1.1");
    const ok = limiter.acquire("alice", "1.1.1.1");
    if (!ok.allowed) throw new Error("expected allowed");
    ok.release();
    // 19 failures remain on the ip: one more is allowed, then blocked
    expect(limiter.acquire("bob", "1.1.1.1").allowed).toBe(true);
    expect(limiter.acquire("carol", "1.1.1.1").allowed).toBe(false);
  });

  it("hard-caps the number of tracked counters, evicting the oldest", () => {
    let now = 1_000_000;
    const limiter = new LoginRateLimiter(
      () => now,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxKeys: 30 },
    );
    for (let i = 0; i < 200; i++) {
      limiter.acquire(`user${i}`, `10.0.${i >> 8}.${i & 255}`);
      now += 1;
    }
    expect(limiter.size).toBeLessThanOrEqual(30);
    // the newest attempts are still tracked
    for (let i = 0; i < 4; i++) limiter.acquire("user199", "10.0.0.199");
    expect(limiter.acquire("user199", "10.0.0.199").allowed).toBe(false);
  });

  it("lane bookkeeping returns to empty after attempts finish", async () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 12; i++) limiter.acquire("alice", `10.0.0.${i}`);
    const r = limiter.acquire("alice", "10.0.1.1", true);
    if (!r.allowed) throw new Error("expected allowed");
    await r.waitTurn(async () => {});
    r.done();
    r.done();
    const again = limiter.acquire("alice", "10.0.1.2", true);
    const third = limiter.acquire("alice", "10.0.1.3", true);
    const fourth = limiter.acquire("alice", "10.0.1.4", true);
    const fifth = limiter.acquire("alice", "10.0.1.5", true);
    expect([again, third, fourth].every((x) => x.allowed)).toBe(true);
    expect(fifth.allowed).toBe(false);
    if (again.allowed) again.done();
    expect(limiter.acquire("alice", "10.0.1.6", true).allowed).toBe(true);
  });
});
