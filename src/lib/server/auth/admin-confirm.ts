import { randomBytes } from "node:crypto";
import { adminActionLimiter, type LoginRateLimiter } from "./rate-limit";
import { reauthenticatePasswordOnly } from "./two-factor";

/** Password re-check before an administrator action. Throws AuthError or RateLimitedError. */
export function confirmAdminPassword(
  userId: string,
  password: string,
  limiter: LoginRateLimiter = adminActionLimiter,
): Promise<void> {
  return reauthenticatePasswordOnly(userId, password, limiter);
}

export const DOWNLOAD_TOKEN_TTL_MS = 60_000;
const MAX_TOKENS = 100;

const downloadTokens = new Map<string, { userId: string; expiresAt: number }>();

function sweep(now: number): void {
  for (const [token, entry] of downloadTokens) {
    if (entry.expiresAt <= now) downloadTokens.delete(token);
  }
}

/**
 * One-time token that lets a password-confirmed admin start a file download
 * (a plain link cannot carry the password). Bound to the user, short-lived.
 */
export function issueDownloadToken(
  userId: string,
  now: number = Date.now(),
): string {
  sweep(now);
  if (downloadTokens.size >= MAX_TOKENS) {
    const oldest = downloadTokens.keys().next().value;
    if (oldest !== undefined) downloadTokens.delete(oldest);
  }
  const token = randomBytes(32).toString("base64url");
  downloadTokens.set(token, {
    userId,
    expiresAt: now + DOWNLOAD_TOKEN_TTL_MS,
  });
  return token;
}

export function consumeDownloadToken(
  token: string | null,
  userId: string,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const entry = downloadTokens.get(token);
  if (!entry) return false;
  downloadTokens.delete(token);
  return entry.userId === userId && entry.expiresAt > now;
}

export function resetDownloadTokens(): void {
  downloadTokens.clear();
}
