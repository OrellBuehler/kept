import { loginRateLimiter, type LoginRateLimiter } from "./rate-limit";
import { verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, purgeExpiredSessions } from "./sessions";
import { findUserByUsername } from "./users";
import type { SessionInfo, SessionUser } from "./types";

export { RateLimitedError } from "./rate-limit";

export interface LoginResult {
  user: SessionUser;
  token: string;
  session: SessionInfo;
}

let warnedAddress = false;

/** Client address for rate limiting; a fixed shared key if the adapter cannot provide one. */
export function clientKey(getClientAddress: () => string): string {
  try {
    return getClientAddress();
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

/**
 * Returns null for any credential failure (unknown user and wrong password are
 * indistinguishable). Throws RateLimitedError when blocked.
 * `username` must already be trimmed and lowercased.
 */
export async function authenticate(
  username: string,
  password: string,
  ip: string,
  limiter: LoginRateLimiter = loginRateLimiter,
  now: number = Date.now(),
): Promise<LoginResult | null> {
  // Reserved before any await so parallel guesses are counted immediately.
  const release = limiter.acquireOrThrow(username, ip);

  const row = findUserByUsername(username);
  let ok = false;
  if (row) ok = await verifyPassword(password, row.passwordHash);
  else await verifyAgainstDummy(password);

  if (!row || !ok) return null;

  release();
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
