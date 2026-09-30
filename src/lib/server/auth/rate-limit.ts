export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_USER_IP = 5;
export const MAX_FAILURES_PER_IP = 20;

const SWEEP_THRESHOLD = 5000;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; retryAfterMinutes: number };

export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly windowMs = WINDOW_MS,
    private readonly maxPerUserIp = MAX_FAILURES_PER_USER_IP,
    private readonly maxPerIp = MAX_FAILURES_PER_IP,
  ) {}

  private userKey(username: string, ip: string): string {
    return `u|${ip}|${username}`;
  }

  private ipKey(ip: string): string {
    return `ip|${ip}`;
  }

  private recent(key: string, now: number): number[] {
    const list = this.failures.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else if (kept.length !== list.length) this.failures.set(key, kept);
    return kept;
  }

  private blockedFor(key: string, max: number, now: number): number {
    const list = this.recent(key, now);
    if (list.length < max) return 0;
    // Blocked until enough old failures age out to drop below the limit.
    return list[list.length - max] + this.windowMs - now;
  }

  check(username: string, ip: string): RateLimitResult {
    const now = this.clock();
    const wait = Math.max(
      this.blockedFor(this.userKey(username, ip), this.maxPerUserIp, now),
      this.blockedFor(this.ipKey(ip), this.maxPerIp, now),
    );
    if (wait <= 0) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: wait,
      retryAfterMinutes: Math.max(1, Math.ceil(wait / 60_000)),
    };
  }

  recordFailure(username: string, ip: string): void {
    const now = this.clock();
    if (this.failures.size > SWEEP_THRESHOLD) this.sweep(now);
    for (const key of [this.userKey(username, ip), this.ipKey(ip)]) {
      const list = this.recent(key, now);
      list.push(now);
      this.failures.set(key, list);
    }
  }

  /** A successful login clears the username+IP counter (the IP counter keeps counting). */
  recordSuccess(username: string, ip: string): void {
    this.failures.delete(this.userKey(username, ip));
  }

  reset(): void {
    this.failures.clear();
  }

  private sweep(now: number): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }
}

export const loginRateLimiter = new LoginRateLimiter();
