export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_USER_IP = 5;
export const MAX_FAILURES_PER_IP = 20;
/** Failures on one username across all IPs before attempts on it are slowed down (never blocked). */
export const DELAY_AFTER_FAILURES_PER_USER = 10;
export const DELAY_STEP_MS = 250;
export const DELAY_MAX_MS = 5000;

/** Delayed attempts allowed in flight per username; the excess is rejected at once. */
export const MAX_QUEUED_PER_USER = 3;
/** Delayed attempts allowed in flight across all usernames. */
export const MAX_QUEUED_GLOBAL = 200;
/** Hard cap on tracked counters; the oldest are evicted first. */
export const MAX_TRACKED_KEYS = 10_000;

/** How long a successful login keeps its client address "known" for that username. */
export const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on remembered (username, address) successes; the oldest are evicted first. */
export const MAX_TRACKED_SUCCESSES = 10_000;

const SWEEP_THRESHOLD = 5000;

export interface LimiterOptions {
  maxQueuedPerUser?: number;
  maxQueuedGlobal?: number;
  maxKeys?: number;
  maxSuccesses?: number;
}

interface Lane {
  waiting: number;
  tail: Promise<void>;
}

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
      /** Backoff to wait before verifying; non-zero only for a username under distributed guessing. */
      delayMs: number;
      /**
       * Waits for this attempt's turn: attempts on a username under pressure
       * run one at a time, each after its backoff. Resolves at once when no
       * backoff applies.
       */
      waitTurn: (sleep: (ms: number) => Promise<void>) => Promise<void>;
      /** Leaves the queue; call in a finally once the attempt is finished. Idempotent. */
      done: () => void;
    }
  | { allowed: false; retryAfterMs: number; retryAfterMinutes: number };

/**
 * Sliding-window failure limiter. An attempt is *reserved* synchronously
 * (before any await) and only refunded on success, so parallel guesses cannot
 * slip past the check while an earlier one is still being verified.
 *
 * Hard blocks apply per username+IP (tight) and per IP across usernames. A
 * username alone is never blocked, otherwise anyone could lock a known
 * account out by failing on purpose (or, behind a proxy that hides client
 * addresses, everyone would share one budget). Instead, many failures on one
 * username across all IPs add a growing delay to further attempts on it,
 * which caps the rate of a distributed guess without denying the owner.
 *
 * The backoff is a real throttle, not just latency: once a username is under
 * pressure its attempts are serialised (one at a time, each after its
 * backoff), at most `maxQueuedPerUser` of them may be waiting, and at most
 * `maxQueuedGlobal` across all usernames. The excess is rejected immediately
 * with the normal "try again" error, so the wait is bounded and nothing is
 * ever locked. The counter map is capped too (oldest entries are evicted).
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();
  private lanes = new Map<string, Lane>();
  private successes = new Map<string, number>();
  private queuedTotal = 0;
  private readonly maxQueuedPerUser: number;
  private readonly maxQueuedGlobal: number;
  private readonly maxKeys: number;
  private readonly maxSuccesses: number;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly windowMs = WINDOW_MS,
    private readonly maxPerUserIp = MAX_FAILURES_PER_USER_IP,
    private readonly maxPerIp = MAX_FAILURES_PER_IP,
    private readonly delayAfterPerUser = DELAY_AFTER_FAILURES_PER_USER,
    private readonly delayStepMs = DELAY_STEP_MS,
    private readonly delayMaxMs = DELAY_MAX_MS,
    options: LimiterOptions = {},
  ) {
    this.maxQueuedPerUser = options.maxQueuedPerUser ?? MAX_QUEUED_PER_USER;
    this.maxQueuedGlobal = options.maxQueuedGlobal ?? MAX_QUEUED_GLOBAL;
    this.maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
    this.maxSuccesses = options.maxSuccesses ?? MAX_TRACKED_SUCCESSES;
  }

  private successKey(username: string, ip: string): string {
    return `${ip}|${username}`;
  }

  /**
   * Remembers that this client address completed a full login (including any
   * second factor) as this user. Such a client skips the per-username queue
   * and backoff; it still counts against the username+IP and per-IP limits.
   * In memory only: lost on restart.
   */
  recordSuccess(username: string, ip: string): void {
    const key = this.successKey(username, ip);
    this.successes.delete(key);
    this.successes.set(key, this.clock());
    while (this.successes.size > this.maxSuccesses) {
      const oldest = this.successes.keys().next();
      if (oldest.done) return;
      this.successes.delete(oldest.value);
    }
  }

  private isKnownClient(username: string, ip: string, now: number): boolean {
    const key = this.successKey(username, ip);
    const at = this.successes.get(key);
    if (at === undefined) return false;
    if (now - at > SUCCESS_TTL_MS) {
      this.successes.delete(key);
      return false;
    }
    return true;
  }

  /** Number of attempts currently waiting in per-username queues (for tests and diagnostics). */
  get queued(): number {
    return this.queuedTotal;
  }

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

  /**
   * Synchronously checks the limits and, if allowed, reserves one attempt.
   * With `throttle`, an attempt that owes a backoff must also fit into the
   * bounded per-username and global queues, else it is rejected right away.
   */
  acquire(username: string, ip: string, throttle = false): Acquired {
    const now = this.clock();
    const uiKey = this.userIpKey(username, ip);
    const ipKey = this.ipKey(ip);
    const uKey = this.userKey(username);
    const wait = Math.max(
      this.blockedFor(uiKey, this.maxPerUserIp, now),
      this.blockedFor(ipKey, this.maxPerIp, now),
    );
    if (wait > 0) {
      return {
        allowed: false,
        retryAfterMs: wait,
        retryAfterMinutes: Math.max(1, Math.ceil(wait / 60_000)),
      };
    }
    const priorForUser = this.recent(uKey, now).length;
    const over = priorForUser - this.delayAfterPerUser + 1;
    const known = this.isKnownClient(username, ip, now);
    const delayMs =
      over > 0 && !known
        ? Math.min(this.delayMaxMs, over * this.delayStepMs)
        : 0;
    let lane = this.lanes.get(username);
    const queued = throttle && delayMs > 0;
    if (
      queued &&
      ((lane?.waiting ?? 0) >= this.maxQueuedPerUser ||
        this.queuedTotal >= this.maxQueuedGlobal)
    ) {
      return {
        allowed: false,
        retryAfterMs: this.delayMaxMs,
        retryAfterMinutes: 1,
      };
    }
    if (this.failures.size > SWEEP_THRESHOLD) this.sweep(now);
    for (const key of [uiKey, ipKey, uKey]) {
      const list = this.recent(key, now);
      list.push(now);
      // re-insert so Map order tracks recency and eviction drops the stalest
      this.failures.delete(key);
      this.failures.set(key, list);
    }
    this.evict();
    let prev: Promise<void> = Promise.resolve();
    let finish = () => {};
    let left = false;
    if (queued) {
      if (!lane) {
        lane = { waiting: 0, tail: Promise.resolve() };
        this.lanes.set(username, lane);
      }
      const mine = lane;
      prev = mine.tail;
      mine.tail = new Promise<void>((resolve) => (finish = resolve));
      mine.waiting++;
      this.queuedTotal++;
    }
    return {
      allowed: true,
      delayMs,
      waitTurn: async (sleep) => {
        if (!queued) return;
        await prev;
        await sleep(delayMs);
      },
      done: () => {
        if (!queued || left) return;
        left = true;
        finish();
        this.queuedTotal--;
        const l = this.lanes.get(username);
        if (l && --l.waiting <= 0) this.lanes.delete(username);
      },
      release: () => {
        this.removeOne(ipKey, now);
        this.removeOne(uKey, now);
        this.failures.delete(uiKey);
      },
    };
  }

  /**
   * Throws RateLimitedError when blocked. Never joins a queue, so there is
   * nothing to wait for or leave afterwards.
   */
  acquireOrThrow(username: string, ip: string): () => void {
    const r = this.acquire(username, ip, false);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMinutes);
    return r.release;
  }

  /**
   * Like acquireOrThrow, but for attempts that wait out the backoff in the
   * bounded per-username queue: await `waitTurn`, and call `done` in a finally.
   */
  reserve(
    username: string,
    ip: string,
  ): {
    release: () => void;
    delayMs: number;
    waitTurn: (sleep: (ms: number) => Promise<void>) => Promise<void>;
    done: () => void;
  } {
    const r = this.acquire(username, ip, true);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMinutes);
    return {
      release: r.release,
      delayMs: r.delayMs,
      waitTurn: r.waitTurn,
      done: r.done,
    };
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
    this.successes.clear();
  }

  /** Number of tracked counters (for tests and diagnostics). */
  get size(): number {
    return this.failures.size;
  }

  private evict(): void {
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next();
      if (oldest.done) return;
      this.failures.delete(oldest.value);
    }
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

/** Unauthenticated passkey option requests per IP (each creates a challenge row); never refunded. */
export const passkeyOptionsLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  60,
  Infinity,
  Infinity,
);

/** First-run /setup submissions per IP (each costs a password hash); call with username "setup". */
export const setupLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  MAX_FAILURES_PER_USER_IP * 2,
  Infinity,
  Infinity,
);

/** Password confirmation for administrator actions, keyed by user id (ip "-"). */
export const adminActionLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  MAX_FAILURES_PER_USER_IP,
  Infinity,
  Infinity,
);

/** Password and code confirmation when creating an API token, keyed by user id (ip "-"). */
export const apiTokenConfirmLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  MAX_FAILURES_PER_USER_IP,
  Infinity,
  Infinity,
);
