export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_USER_IP = 5;
export const MAX_FAILURES_PER_USER = 20;
export const MAX_FAILURES_PER_IP = 20;

const SWEEP_THRESHOLD = 5000;

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMinutes: number) {
    super(
      `Too many attempts, try again in ${retryAfterMinutes} ${retryAfterMinutes === 1 ? "minute" : "minutes"}.`,
    );
    this.name = "RateLimitedError";
  }
}

export type Acquired =
  | {
      allowed: true;
      /** Call after a successful attempt: refunds the reservation and clears the username+IP counter. */
      release: () => void;
    }
  | { allowed: false; retryAfterMs: number; retryAfterMinutes: number };

/**
 * Sliding-window failure limiter. An attempt is *reserved* synchronously
 * (before any await) and only refunded on success, so parallel guesses cannot
 * slip past the check while an earlier one is still being verified.
 *
 * Three counters: username+IP (tight), IP (across usernames), and username
 * across all IPs (looser). The last one stops a distributed guess against one
 * account, at the price that an attacker can lock a known username out for up
 * to one window by deliberately failing; the looser cap keeps that
 * unattractive while a legitimate user on their usual IP is only hit by the
 * tighter counters of others.
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly windowMs = WINDOW_MS,
    private readonly maxPerUserIp = MAX_FAILURES_PER_USER_IP,
    private readonly maxPerIp = MAX_FAILURES_PER_IP,
    private readonly maxPerUser = MAX_FAILURES_PER_USER,
  ) {}

  private userIpKey(username: string, ip: string): string {
    return `u|${ip}|${username}`;
  }

  private ipKey(ip: string): string {
    return `ip|${ip}`;
  }

  private userKey(username: string): string {
    return `n|${username}`;
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
    return list[list.length - max] + this.windowMs - now;
  }

  /** Synchronously checks the limits and, if allowed, reserves one attempt. */
  acquire(username: string, ip: string): Acquired {
    const now = this.clock();
    const uiKey = this.userIpKey(username, ip);
    const ipKey = this.ipKey(ip);
    const uKey = this.userKey(username);
    const wait = Math.max(
      this.blockedFor(uiKey, this.maxPerUserIp, now),
      this.blockedFor(ipKey, this.maxPerIp, now),
      this.blockedFor(uKey, this.maxPerUser, now),
    );
    if (wait > 0) {
      return {
        allowed: false,
        retryAfterMs: wait,
        retryAfterMinutes: Math.max(1, Math.ceil(wait / 60_000)),
      };
    }
    if (this.failures.size > SWEEP_THRESHOLD) this.sweep(now);
    for (const key of [uiKey, ipKey, uKey]) {
      const list = this.recent(key, now);
      list.push(now);
      this.failures.set(key, list);
    }
    return {
      allowed: true,
      release: () => {
        this.removeOne(ipKey, now);
        this.removeOne(uKey, now);
        this.failures.delete(uiKey);
      },
    };
  }

  /** Throws RateLimitedError when blocked. */
  acquireOrThrow(username: string, ip: string): () => void {
    const r = this.acquire(username, ip);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMinutes);
    return r.release;
  }

  private removeOne(key: string, stamp: number): void {
    const list = this.failures.get(key);
    if (!list) return;
    const i = list.indexOf(stamp);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.failures.delete(key);
  }

  reset(): void {
    this.failures.clear();
  }

  private sweep(now: number): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }
}

export const loginRateLimiter = new LoginRateLimiter();

/** Current-password guesses in changePassword, keyed by user id (call with ip "-"). */
export const passwordChangeLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  MAX_FAILURES_PER_USER_IP,
  Infinity,
  Infinity,
);

/** Second-step codes at login, keyed by user id and IP. */
export const secondFactorLimiter = new LoginRateLimiter();

/** Password + code re-authentication for 2FA changes, keyed by user id (ip "-"). */
export const twoFactorManageLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  MAX_FAILURES_PER_USER_IP,
  Infinity,
  Infinity,
);

/** Passwordless passkey sign-in attempts per IP (call with username "passkey"). */
export const passkeyLoginLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  MAX_FAILURES_PER_USER_IP * 2,
  Infinity,
  Infinity,
);
