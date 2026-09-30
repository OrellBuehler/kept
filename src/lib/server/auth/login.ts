import { loginRateLimiter, type LoginRateLimiter } from "./rate-limit";
import { verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, purgeExpiredSessions } from "./sessions";
import { findUserByUsername } from "./users";
import type { SessionInfo, SessionUser } from "./types";

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMinutes: number) {
    super(
      `Too many attempts, try again in ${retryAfterMinutes} ${retryAfterMinutes === 1 ? "minute" : "minutes"}.`,
    );
    this.name = "RateLimitedError";
  }
}

export interface LoginResult {
  user: SessionUser;
  token: string;
  session: SessionInfo;
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
  const gate = limiter.check(username, ip);
  if (!gate.allowed) throw new RateLimitedError(gate.retryAfterMinutes);

  const row = findUserByUsername(username);
  let ok = false;
  if (row) ok = await verifyPassword(password, row.passwordHash);
  else await verifyAgainstDummy(password);

  if (!row || !ok) {
    limiter.recordFailure(username, ip);
    return null;
  }

  limiter.recordSuccess(username, ip);
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
