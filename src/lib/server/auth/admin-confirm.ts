import { randomBytes } from "node:crypto";
import { adminActionLimiter, type LoginRateLimiter } from "./rate-limit";
import {
  getTwoFactorStatus,
  hasRecentReauth,
  reauthenticate,
  reauthenticatePasswordOnly,
} from "./two-factor";
import { AuthError } from "./types";

/**
 * Re-checks the acting administrator before a sensitive action:
 * - with an authenticator app: password plus a current code (or a recovery code);
 * - with passkeys only: password plus a passkey step-up of this session within
 *   REAUTH_WINDOW_MS (done on the security page), since a code cannot be typed;
 * - without a second factor: password only.
 * Throws AuthError (invalid_credentials, invalid_code, passkey_required) or RateLimitedError.
 */
export async function confirmAdmin(
  userId: string,
  sessionId: string | undefined,
  input: { password: string; code?: string },
  limiter: LoginRateLimiter = adminActionLimiter,
  now: number = Date.now(),
): Promise<void> {
  const status = getTwoFactorStatus(userId);
  if (status.totpEnabled) {
    await reauthenticate(
      userId,
      input.password,
      input.code ?? "",
      limiter,
      now,
    );
    return;
  }
  if (status.passkeyCount > 0 && !hasRecentReauth(sessionId, now)) {
    throw new AuthError(
      "passkey_required",
      "Confirm with one of your passkeys on the security page first.",
    );
  }
  await reauthenticatePasswordOnly(userId, input.password, limiter);
}

/** Which extra proof the administrator's forms must ask for. */
export function adminConfirmMode(
  userId: string,
): "password" | "totp" | "passkey" {
  const status = getTwoFactorStatus(userId);
  if (status.totpEnabled) return "totp";
  return status.passkeyCount > 0 ? "passkey" : "password";
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
