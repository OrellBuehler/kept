import { randomInt } from "node:crypto";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import {
  first,
  getDB,
  passkeys,
  recoveryCodes,
  authChallenges,
  sessions,
  totpCredentials,
  users,
  transaction,
} from "$lib/server/db";
import {
  SecretUnreadableError,
  decryptSecret,
  encryptSecret,
} from "$lib/server/crypto";
import { logAuthEvent, logAuthEventInTx } from "./events";
import { verifyPassword } from "./password";
import { twoFactorManageLimiter, type LoginRateLimiter } from "./rate-limit";
import { hashToken, userSessionsDelete } from "./sessions";
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

export async function getTwoFactorStatus(
  userId: string,
): Promise<TwoFactorStatus> {
  const db = getDB();
  const totp = await first(
    db
      .select({ confirmedAt: totpCredentials.confirmedAt })
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId))
      .limit(1),
  );
  const totpEnabled = !!totp?.confirmedAt;
  const passkeyCount =
    (
      await first(
        db
          .select({ n: count() })
          .from(passkeys)
          .where(eq(passkeys.userId, userId)),
      )
    )?.n ?? 0;
  const recoveryCodesRemaining = totpEnabled
    ? ((
        await first(
          db
            .select({ n: count() })
            .from(recoveryCodes)
            .where(
              and(
                eq(recoveryCodes.userId, userId),
                isNull(recoveryCodes.usedAt),
              ),
            ),
        )
      )?.n ?? 0)
    : 0;
  return {
    totpEnabled,
    passkeyCount,
    enabled: totpEnabled || passkeyCount > 0,
    recoveryCodesRemaining,
  };
}

export async function hasSecondFactor(userId: string): Promise<boolean> {
  return (await getTwoFactorStatus(userId)).enabled;
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
export async function getPendingTotpEnrolment(
  userId: string,
  username: string,
): Promise<TotpEnrolment | null> {
  const row = await first(
    getDB()
      .select()
      .from(totpCredentials)
      .where(
        and(
          eq(totpCredentials.userId, userId),
          isNull(totpCredentials.confirmedAt),
        ),
      )
      .limit(1),
  );
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
export async function startTotpEnrolment(
  userId: string,
  username: string,
): Promise<TotpEnrolment> {
  const secret = generateTotpSecret();
  const encrypted = encryptSecret(secret);
  await transaction(async (tx) => {
    const existing = await first(
      tx
        .select({ confirmedAt: totpCredentials.confirmedAt })
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, userId))
        .limit(1),
    );
    if (existing?.confirmedAt) {
      throw new AuthError(
        "totp_already_enabled",
        "Authenticator app is already enabled.",
      );
    }
    await tx.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
    await tx.insert(totpCredentials).values({ userId, secret: encrypted });
  });
  return { secret, uri: otpauthUri(secret, username) };
}

export async function cancelTotpEnrolment(userId: string): Promise<void> {
  await getDB()
    .delete(totpCredentials)
    .where(
      and(
        eq(totpCredentials.userId, userId),
        isNull(totpCredentials.confirmedAt),
      ),
    );
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

/** Runs inside a transaction, so the recovery-code set is replaced atomically. */
async function replaceRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await tx
    .insert(recoveryCodes)
    .values(
      codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    );
  return codes;
}

/**
 * Atomically checks `code` against the stored secret and records the matched
 * time step, so the same code (or an older one) is never accepted twice.
 */
export async function consumeTotpCode(
  userId: string,
  code: string,
  now: number = Date.now(),
  opts: { confirming?: boolean } = {},
): Promise<boolean> {
  return await transaction(async (tx) => {
    const row = await first(
      tx
        .select()
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, userId))
        .limit(1),
    );
    if (!row) return false;
    if (!opts.confirming && !row.confirmedAt) return false;
    // Confirming twice in parallel must not both pass: the check in
    // confirmTotpEnrolment is not atomic with this one.
    if (opts.confirming && row.confirmedAt) return false;
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
    await tx
      .update(totpCredentials)
      .set({
        lastStep: step,
        ...(opts.confirming ? { confirmedAt: new Date(now) } : {}),
      })
      .where(eq(totpCredentials.userId, userId));
    return true;
  });
}

/** Confirms enrolment with a code from the app and returns the recovery codes (shown once). */
export async function confirmTotpEnrolment(
  userId: string,
  code: string,
  now: number = Date.now(),
): Promise<string[]> {
  const row = await first(
    getDB()
      .select({ confirmedAt: totpCredentials.confirmedAt })
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId))
      .limit(1),
  );
  if (!row || row.confirmedAt) {
    throw new AuthError("totp_not_pending", "No enrolment in progress.");
  }
  if (!(await consumeTotpCode(userId, code, now, { confirming: true }))) {
    throw new AuthError("invalid_code", "That code is not valid.");
  }
  const codes = await transaction(
    async (tx) => await replaceRecoveryCodes(tx, userId),
  );
  await logAuthEvent("totp_enabled", userId);
  return codes;
}

/** Atomic use-once: the row is only claimed if it was still unused. */
export async function consumeRecoveryCode(
  userId: string,
  input: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== RECOVERY_LENGTH) return false;
  const db = getDB();
  const result = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.userId, userId),
        eq(recoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .returning({ id: recoveryCodes.id });
  if (result.length !== 1) return false;
  await logAuthEvent("recovery_code_used", userId);
  return true;
}

/** Second-step check: a 6 digit authenticator code, otherwise a recovery code. */
export async function verifySecondFactorCode(
  userId: string,
  input: string,
  now: number = Date.now(),
): Promise<boolean> {
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
  return refundOnFault(release, async () => {
    const row = await first(
      getDB()
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    if (!row) throw new AuthError("user_not_found", "User not found.");
    if (!(await verifyPassword(password, row.passwordHash))) {
      throw new AuthError("invalid_credentials", "Password is incorrect.");
    }
    return release;
  });
}

/**
 * Runs `fn` with a limiter attempt held: a wrong credential (an `AuthError`) keeps the
 * attempt counted, any other failure (a database error) gives it back.
 */
async function refundOnFault<T>(
  release: () => void,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AuthError)) release();
    throw err;
  }
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
  const status = await getTwoFactorStatus(userId);
  if (!status.totpEnabled && status.passkeyCount > 0) {
    throw new AuthError(
      "passkey_required",
      "Confirm with one of your passkeys.",
    );
  }
  const release = await checkPassword(userId, password, limiter);
  await refundOnFault(release, async () => {
    if (
      status.totpEnabled &&
      !(await verifySecondFactorCode(userId, code, now))
    ) {
      throw new AuthError("invalid_code", "That code is not valid.");
    }
  });
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
  const status = await getTwoFactorStatus(userId);
  if (!status.totpEnabled && status.passkeyCount > 0) {
    throw new AuthError(
      "passkey_required",
      "Confirm with one of your passkeys.",
    );
  }
  await reauthenticate(userId, password, code, limiter, now);
  await markSessionReauthenticated(userId, sessionId, now);
}

export async function markSessionReauthenticated(
  userId: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<void> {
  await getDB()
    .update(sessions)
    .set({ reauthAt: new Date(now) })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function hasRecentReauth(
  sessionId: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!sessionId) return false;
  const row = await first(
    getDB()
      .select({ reauthAt: sessions.reauthAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1),
  );
  return !!row?.reauthAt && now - row.reauthAt.getTime() <= REAUTH_WINDOW_MS;
}

export async function disableTotp(
  userId: string,
  password: string,
  code: string,
  limiter: LoginRateLimiter = twoFactorManageLimiter,
  now: number = Date.now(),
): Promise<void> {
  if (!(await getTwoFactorStatus(userId)).totpEnabled) {
    throw new AuthError(
      "totp_not_enabled",
      "Authenticator app is not enabled.",
    );
  }
  await reauthenticate(userId, password, code, limiter, now);
  await transaction(async (tx) => {
    await tx.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  });
  await logAuthEvent("totp_disabled", userId);
}

export async function regenerateRecoveryCodes(
  userId: string,
  password: string,
  code: string,
  limiter: LoginRateLimiter = twoFactorManageLimiter,
  now: number = Date.now(),
): Promise<string[]> {
  if (!(await getTwoFactorStatus(userId)).totpEnabled) {
    throw new AuthError(
      "totp_not_enabled",
      "Authenticator app is not enabled.",
    );
  }
  await reauthenticate(userId, password, code, limiter, now);
  const codes = await transaction(
    async (tx) => await replaceRecoveryCodes(tx, userId),
  );
  await logAuthEvent("recovery_codes_regenerated", userId);
  return codes;
}

/**
 * Admin recovery path (lost device): removes every second factor and pending
 * login of the user and signs their other sessions out.
 */
export async function resetTwoFactor(
  actorId: string,
  targetId: string,
  keepSessionId?: string,
  audit?: InTransaction<{ id: string; username: string }>,
): Promise<void> {
  await transaction(async (tx) => {
    const target = await first(
      tx
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1),
    );
    if (!target) throw new AuthError("user_not_found", "User not found.");
    await tx
      .delete(totpCredentials)
      .where(eq(totpCredentials.userId, targetId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, targetId));
    await tx.delete(passkeys).where(eq(passkeys.userId, targetId));
    await tx.delete(authChallenges).where(eq(authChallenges.userId, targetId));
    await userSessionsDelete(
      tx,
      targetId,
      actorId === targetId ? keepSessionId : undefined,
    );
    await logAuthEventInTx(tx, "two_factor_reset", targetId, actorId);
    await audit?.(tx, target);
  });
}

export async function usersWithTwoFactor(): Promise<Set<string>> {
  const db = getDB();
  const ids = new Set<string>();
  for (const r of await db
    .select({ userId: totpCredentials.userId })
    .from(totpCredentials)
    .where(isNotNull(totpCredentials.confirmedAt))) {
    ids.add(r.userId);
  }
  for (const r of await db.select({ userId: passkeys.userId }).from(passkeys)) {
    ids.add(r.userId);
  }
  return ids;
}
