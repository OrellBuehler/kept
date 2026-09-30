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
  it("allows up to 5 failures per username+ip, then blocks with a wait time", () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("alice", "1.1.1.1").allowed).toBe(true);
      limiter.recordFailure("alice", "1.1.1.1");
    }
    const r = limiter.check("alice", "1.1.1.1");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterMinutes).toBe(15);
  });

  it("does not block other usernames from the same ip or other ips", () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) limiter.recordFailure("alice", "1.1.1.1");
    expect(limiter.check("bob", "1.1.1.1").allowed).toBe(true);
    expect(limiter.check("alice", "2.2.2.2").allowed).toBe(true);
  });

  it("blocks an ip after 20 failures across usernames", () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i++) limiter.recordFailure(`user${i}`, "1.1.1.1");
    expect(limiter.check("fresh", "1.1.1.1").allowed).toBe(false);
    expect(limiter.check("fresh", "9.9.9.9").allowed).toBe(true);
  });

  it("slides: failures age out of the window", () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure("alice", "1.1.1.1");
      advance(MIN);
    }
    // oldest failure was 5 minutes ago; it expires in 10 minutes
    const blocked = limiter.check("alice", "1.1.1.1");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMinutes).toBe(10);
    advance(10 * MIN);
    expect(limiter.check("alice", "1.1.1.1").allowed).toBe(true);
  });

  it("success clears the username+ip counter", () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i++) limiter.recordFailure("alice", "1.1.1.1");
    limiter.recordSuccess("alice", "1.1.1.1");
    for (let i = 0; i < 4; i++) limiter.recordFailure("alice", "1.1.1.1");
    expect(limiter.check("alice", "1.1.1.1").allowed).toBe(true);
  });
});
