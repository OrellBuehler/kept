import { isIP } from "node:net";
import { ipv6Bytes } from "$lib/server/net/ip";
import {
  createPendingLogin,
  deletePendingLogin,
  getPendingLogin,
  recordPendingFailure,
} from "./challenges";
import {
  loginRateLimiter,
  secondFactorLimiter,
  type LoginRateLimiter,
} from "./rate-limit";
import { hasSecondFactor, verifySecondFactorCode } from "./two-factor";
import { verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, purgeExpiredSessions } from "./sessions";
import { findUserByUsername, findUserById } from "./users";
import { AuthError } from "./types";
import type { SessionInfo, SessionUser } from "./types";

export { RateLimitedError } from "./rate-limit";

export interface LoginResult {
  user: SessionUser;
  token: string;
  session: SessionInfo;
}

let warnedAddress = false;

/**
 * The rate-limit key for an address: IPv4 as is, IPv4-mapped IPv6 as the IPv4
 * address, and any other IPv6 address as its /64 prefix (one subscriber
 * routinely controls a whole /64, so per-address budgets would be free).
 */
export function normalizeClientAddress(address: string): string {
  const bytes =
    isIP(address.split("%")[0]) === 6 ? ipv6Bytes(address.split("%")[0]) : null;
  if (!bytes) return address;
  const mapped =
    bytes.slice(0, 10).every((x) => x === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255;
  if (mapped) return bytes.slice(12).join(".");
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 2) {
    groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return `${groups.join(":")}::/64`;
}

/** Client address for rate limiting; a fixed shared key if the adapter cannot provide one. */
export function clientKey(getClientAddress: () => string): string {
  try {
    return normalizeClientAddress(getClientAddress());
  } catch {
    if (!warnedAddress) {
      warnedAddress = true;
      console.warn(
        "Could not determine the client address; rate limiting falls back to a single shared key. Check ADDRESS_HEADER / XFF_DEPTH.",
      );
    }
    return "unknown";
  }
}

/** Logs once if ADDRESS_HEADER is unset: behind a proxy every client then shares one rate-limit key. */
export function warnIfAddressHeaderUnset(env = process.env): void {
  if (env.ADDRESS_HEADER) return;
  console.warn(
    "ADDRESS_HEADER is not set. If Kept runs behind a reverse proxy, all clients share the proxy address for login rate limiting; set ADDRESS_HEADER (e.g. X-Forwarded-For) and XFF_DEPTH.",
  );
}

let warnedProxy = false;

/** Cheap runtime hint: proxy headers present while ADDRESS_HEADER is unset means the address is the proxy's. */
export function warnIfProxied(headers: Headers, env = process.env): void {
  if (warnedProxy || env.ADDRESS_HEADER) return;
  if (
    headers.has("x-forwarded-for") ||
    headers.has("x-real-ip") ||
    headers.has("forwarded")
  ) {
    warnedProxy = true;
    console.warn(
      "Requests carry proxy headers but ADDRESS_HEADER is not set; login rate limiting sees only the proxy address, so one client's failures can block others. Set ADDRESS_HEADER and XFF_DEPTH.",
    );
  }
}

export function resetAddressWarnings(): void {
  warnedProxy = false;
  warnedAddress = false;
}

export interface SecondFactorRequired {
  secondFactorRequired: true;
  /** Opaque token for the short-lived half-authenticated state; goes into a cookie. */
  token: string;
  expiresAt: Date;
}

/** Full login for a user whose factors are all satisfied. */
export function issueLogin(
  userId: string,
  now: number = Date.now(),
): LoginResult {
  const row = findUserById(userId);
  if (!row) throw new AuthError("user_not_found", "User not found.");
  purgeExpiredSessions(now);
  const { token, session } = createSession(row.id, now);
  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    },
    token,
    session,
  };
}

/**
 * Returns null for any credential failure (unknown user and wrong password are
 * indistinguishable). Throws RateLimitedError when blocked. When the user has
 * a second factor the password alone does not log in: a pending state is
 * returned instead and no session exists yet.
 * `username` must already be trimmed and lowercased.
 */
export async function authenticate(
  username: string,
  password: string,
  ip: string,
  limiter: LoginRateLimiter = loginRateLimiter,
  now: number = Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<LoginResult | SecondFactorRequired | null> {
  // Reserved before any await so parallel guesses are counted immediately.
  // A username under distributed guessing is throttled: its attempts queue up
  // (bounded; the excess throws RateLimitedError) and run one at a time.
  const { release, waitTurn, done } = limiter.reserve(username, ip);
  let row;
  let ok = false;
  try {
    await waitTurn(sleep);
    row = findUserByUsername(username);
    if (row) ok = await verifyPassword(password, row.passwordHash);
    else await verifyAgainstDummy(password);
  } finally {
    done();
  }

  if (!row || !ok) return null;

  release();
  if (hasSecondFactor(row.id)) {
    const pending = createPendingLogin(row.id, now);
    return { secondFactorRequired: true, ...pending };
  }
  return issueLogin(row.id, now);
}

/**
 * Second step with a TOTP or recovery code. Returns null for a wrong code,
 * throws AuthError("pending_expired") when there is no live pending login and
 * RateLimitedError when blocked.
 */
export async function completeSecondFactor(
  pendingToken: string | undefined,
  code: string,
  ip: string,
  limiter: LoginRateLimiter = secondFactorLimiter,
  now: number = Date.now(),
): Promise<LoginResult | null> {
  const pending = getPendingLogin(pendingToken, now);
  if (!pending) {
    throw new AuthError(
      "pending_expired",
      "Your sign-in expired. Start again.",
    );
  }
  const release = limiter.acquireOrThrow(pending.userId, ip);
  if (!verifySecondFactorCode(pending.userId, code, now)) {
    recordPendingFailure(pending);
    return null;
  }
  release();
  deletePendingLogin(pending.id);
  return issueLogin(pending.userId, now);
}
