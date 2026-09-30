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

  it("blocks a username after 20 attempts spread across ips", () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i++) limiter.acquire("alice", `10.0.0.${i}`);
    expect(limiter.acquire("alice", "10.0.1.1").allowed).toBe(false);
    expect(limiter.acquire("bob", "10.0.1.1").allowed).toBe(true);
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
});
