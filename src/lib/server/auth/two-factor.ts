import { randomInt } from "node:crypto";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import {
  getDB,
  passkeys,
  recoveryCodes,
  authChallenges,
  sessions,
  totpCredentials,
  users,
} from "$lib/server/db";
import {
  SecretUnreadableError,
  decryptSecret,
  encryptSecret,
} from "$lib/server/crypto";
import { logAuthEvent } from "./events";
import { verifyPassword } from "./password";
import { twoFactorManageLimiter, type LoginRateLimiter } from "./rate-limit";
import { hashToken, invalidateUserSessions } from "./sessions";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";
import { AuthError } from "./types";
import type { InTransaction } from "./users";

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_LENGTH = 16;

export interface TwoFactorStatus {
  totpEnabled: boolean;
  passkeyCount: number;
  /** True when logging in needs more than the password. */
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export function getTwoFactorStatus(userId: string): TwoFactorStatus {
  const db = getDB();
  const totp = db
    .select({ confirmedAt: totpCredentials.confirmedAt })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .get();
  const totpEnabled = !!totp?.confirmedAt;
  const passkeyCount =
    db
      .select({ n: count() })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .get()?.n ?? 0;
  const recoveryCodesRemaining = totpEnabled
    ? (db
        .select({ n: count() })
        .from(recoveryCodes)
        .where(
          and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)),
        )
        .get()?.n ?? 0)
    : 0;
  return {
    totpEnabled,
    passkeyCount,
    enabled: totpEnabled || passkeyCount > 0,
    recoveryCodesRemaining,
  };
}

export function hasSecondFactor(userId: string): boolean {
  return getTwoFactorStatus(userId).enabled;
}

export interface TotpEnrolment {
  secret: string;
  uri: string;
}

function enrolmentFor(username: string, encrypted: string): TotpEnrolment {
  const secret = decryptSecret(encrypted);
  return { secret, uri: otpauthUri(secret, username) };
}

/** The unconfirmed secret of an enrolment in progress, if any. */
export function getPendingTotpEnrolment(
  userId: string,
  username: string,
): TotpEnrolment | null {
  const row = getDB()
    .select()
    .from(totpCredentials)
    .where(
      and(
        eq(totpCredentials.userId, userId),
        isNull(totpCredentials.confirmedAt),
      ),
    )
    .get();
  if (!row) return null;
  try {
    return enrolmentFor(username, row.secret);
  } catch (err) {
    if (!(err instanceof SecretUnreadableError)) throw err;
    // KEPT_SECRET_KEY changed mid-enrolment: treat it as not started; starting again replaces it.
    console.warn("totp enrolment skipped", err.code);
    return null;
  }
}

/** Starts (or restarts) enrolment with a fresh secret. Fails if TOTP is already on. */
export function startTotpEnrolment(
  userId: string,
  username: string,
): TotpEnrolment {
  const secret = generateTotpSecret();
  const encrypted = encryptSecret(secret);
  getDB().transaction(
    (tx) => {
      const existing = tx
        .select({ confirmedAt: totpCredentials.confirmedAt })
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, userId))
        .get();
      if (existing?.confirmedAt) {
        throw new AuthError(
          "totp_already_enabled",
          "Authenticator app is already enabled.",
        );
      }
      tx.delete(totpCredentials)
        .where(eq(totpCredentials.userId, userId))
        .run();
      tx.insert(totpCredentials).values({ userId, secret: encrypted }).run();
    },
    { behavior: "immediate" },
  );
  return { secret, uri: otpauthUri(secret, username) };
}

export function cancelTotpEnrolment(userId: string): void {
  getDB()
    .delete(totpCredentials)
    .where(
      and(
        eq(totpCredentials.userId, userId),
        isNull(totpCredentials.confirmedAt),
      ),
    )
    .run();
}

function newRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return raw.match(/.{4}/g)!.join("-");
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashRecoveryCode(code: string): string {
  return hashToken(normalizeRecoveryCode(code));
}

type Tx = Pick<ReturnType<typeof getDB>, "delete" | "insert">;

function replaceRecoveryCodes(tx: Tx, userId: string): string[] {
  tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  tx.insert(recoveryCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })))
    .run();
  return codes;
}

/**
 * Atomically checks `code` against the stored secret and records the matched
 * time step, so the same code (or an older one) is never accepted twice.
 */
export function consumeTotpCode(
  userId: string,
  code: string,
  now: number = Date.now(),
  opts: { confirming?: boolean } = {},
): boolean {
  return getDB().transaction(
    (tx) => {
      const row = tx
        .select()
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, userId))
        .get();
      if (!row) return false;
      if (!opts.confirming && !row.confirmedAt) return false;
      let secret: string;
      try {
        secret = decryptSecret(row.secret);
      } catch (err) {
        if (!(err instanceof SecretUnreadableError)) throw err;
        // KEPT_SECRET_KEY changed: no authenticator code can match; recovery codes and an admin reset still work.
        console.warn("totp code rejected", err.code);
        return false;
      }
      const step = verifyTotp(secret, code, now, row.lastStep);
      if (step === null) return false;
      tx.update(totpCredentials)
        .set({
          lastStep: step,
          ...(opts.confirming ? { confirmedAt: new Date(now) } : {}),
        })
        .where(eq(totpCredentials.userId, userId))
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
}

/** Confirms enrolment with a code from the app and returns the recovery codes (shown once). */
export function confirmTotpEnrolment(
  userId: string,
  code: string,
  now: number = Date.now(),
): string[] {
  const row = getDB()
    .select({ confirmedAt: totpCredentials.confirmedAt })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .get();
  if (!row || row.confirmedAt) {
    throw new AuthError("totp_not_pending", "No enrolment in progress.");
  }
  if (!consumeTotpCode(userId, code, now, { confirming: true })) {
    throw new AuthError("invalid_code", "That code is not valid.");
  }
  const codes = getDB().transaction((tx) => replaceRecoveryCodes(tx, userId), {
    behavior: "immediate",
  });
  logAuthEvent("totp_enabled", userId);
  return codes;
}

/** Atomic use-once: the row is only claimed if it was still unused. */
export function consumeRecoveryCode(userId: string, input: string): boolean {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== RECOVERY_LENGTH) return false;
  const db = getDB();
  const result = db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id })
    .all();
  if (result.length !== 1) return false;
  logAuthEvent("recovery_code_used", userId);
  return true;
}

/** Second-step check: a 6 digit authenticator code, otherwise a recovery code. */
export function verifySecondFactorCode(
  userId: string,
  input: string,
  now: number = Date.now(),
): boolean {
  const code = input.replace(/\s/g, "");
  if (/^\d{6}$/.test(code)) return consumeTotpCode(userId, code, now);
  return consumeRecoveryCode(userId, code);
}

export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

/** Re-authentication for sensitive changes: current password plus a second-factor code. */
async function checkPassword(
  userId: string,
  password: string,
  limiter: LoginRateLimiter,
): Promise<() => void> {
  const release = limiter.acquireOrThrow(userId, "-");
  const row = getDB()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) throw new AuthError("user_not_found", "User not found.");
  if (!(await verifyPassword(password, row.passwordHash))) {
    throw new AuthError("invalid_credentials", "Password is incorrect.");
  }
  return release;
}

/**
 * Password only. Reserved for the passkey step-up verify path, where the
 * WebAuthn assertion is the proof of possession.
 */
export async function reauthenticatePasswordOnly(
  userId: string,
  password: string,
  limiter: LoginRateLimiter = twoFactorManageLimiter,
): Promise<void> {
  (await checkPassword(userId, password, limiter))();
}

/**
 * Password plus a second-factor code. A user whose only factor is a passkey
 * cannot use this: they must go through the passkey step-up instead.
 */
export async function reauthenticate(
  userId: string,
  password: string,
  code: string,
  limiter: LoginRateLimiter,
  now: number,
): Promise<void> {
  const status = getTwoFactorStatus(userId);
  if (!status.totpEnabled && status.passkeyCount > 0) {
    throw new AuthError(
      "passkey_required",
      "Confirm with one of your passkeys.",
    );
  }
  const release = await checkPassword(userId, password, limiter);
  if (status.totpEnabled && !verifySecondFactorCode(userId, code, now)) {
    throw new AuthError("invalid_code", "That code is not valid.");
  }
  release();
}

/** Step-up for a session: password (+ code if TOTP is on), then valid for REAUTH_WINDOW_MS. */
export async function stepUpSession(
  userId: string,
  sessionId: string,
  password: string,
  code: string,
  limiter: LoginRateLimiter = twoFactorManageLimiter,
  now: number = Date.now(),
): Promise<void> {
  const status = getTwoFactorStatus(userId);
  if (!status.totpEnabled && status.passkeyCount > 0) {
    throw new AuthError(
      "passkey_required",
      "Confirm with one of your passkeys.",
    );
  }
  await reauthenticate(userId, password, code, limiter, now);
  markSessionReauthenticated(userId, sessionId, now);
}

export function markSessionReauthenticated(
  userId: string,
  sessionId: string,
  now: number = Date.now(),
): void {
  getDB()
    .update(sessions)
    .set({ reauthAt: new Date(now) })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .run();
}

export function hasRecentReauth(
  sessionId: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!sessionId) return false;
  const row = getDB()
    .select({ reauthAt: sessions.reauthAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  return !!row?.reauthAt && now - row.reauthAt.getTime() <= REAUTH_WINDOW_MS;
}

export async function disableTotp(
  userId: string,
  password: string,
  code: string,
  limiter: LoginRateLimiter = twoFactorManageLimiter,
  now: number = Date.now(),
): Promise<void> {
  if (!getTwoFactorStatus(userId).totpEnabled) {
    throw new AuthError(
      "totp_not_enabled",
      "Authenticator app is not enabled.",
    );
  }
  await reauthenticate(userId, password, code, limiter, now);
  getDB().transaction((tx) => {
    tx.delete(totpCredentials).where(eq(totpCredentials.userId, userId)).run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  });
  logAuthEvent("totp_disabled", userId);
}

export async function regenerateRecoveryCodes(
  userId: string,
  password: string,
  code: string,
  limiter: LoginRateLimiter = twoFactorManageLimiter,
  now: number = Date.now(),
): Promise<string[]> {
  if (!getTwoFactorStatus(userId).totpEnabled) {
    throw new AuthError(
      "totp_not_enabled",
      "Authenticator app is not enabled.",
    );
  }
  await reauthenticate(userId, password, code, limiter, now);
  const codes = getDB().transaction((tx) => replaceRecoveryCodes(tx, userId), {
    behavior: "immediate",
  });
  logAuthEvent("recovery_codes_regenerated", userId);
  return codes;
}

/**
 * Admin recovery path (lost device): removes every second factor and pending
 * login of the user and signs their other sessions out.
 */
export function resetTwoFactor(
  actorId: string,
  targetId: string,
  keepSessionId?: string,
  audit?: InTransaction<{ id: string; username: string }>,
): void {
  getDB().transaction(
    (tx) => {
      const target = tx
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, targetId))
        .get();
      if (!target) throw new AuthError("user_not_found", "User not found.");
      tx.delete(totpCredentials)
        .where(eq(totpCredentials.userId, targetId))
        .run();
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, targetId)).run();
      tx.delete(passkeys).where(eq(passkeys.userId, targetId)).run();
      tx.delete(authChallenges)
        .where(eq(authChallenges.userId, targetId))
        .run();
      // same connection, so these writes are part of this transaction
      invalidateUserSessions(
        targetId,
        actorId === targetId ? keepSessionId : undefined,
      );
      logAuthEvent("two_factor_reset", targetId, actorId);
      audit?.(tx, target);
    },
    { behavior: "immediate" },
  );
}

export function usersWithTwoFactor(): Set<string> {
  const db = getDB();
  const ids = new Set<string>();
  for (const r of db
    .select({ userId: totpCredentials.userId })
    .from(totpCredentials)
    .where(isNotNull(totpCredentials.confirmedAt))
    .all()) {
    ids.add(r.userId);
  }
  for (const r of db.select({ userId: passkeys.userId }).from(passkeys).all()) {
    ids.add(r.userId);
  }
  return ids;
}
