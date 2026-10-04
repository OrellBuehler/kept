import type { Cookies } from "@sveltejs/kit";
import { and, eq, lt } from "drizzle-orm";
import { authChallenges, getDB, type AuthChallengeKind } from "$lib/server/db";
import { cookieSecureOverride, hashToken } from "./sessions";

export const PENDING_COOKIE = "kept_pending";
/** The half-authenticated state (password ok, second factor outstanding) is short-lived. */
export const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong second-factor attempts before the password has to be entered again. */
export const MAX_PENDING_ATTEMPTS = 5;

type WebauthnKind = Exclude<AuthChallengeKind, "login">;

export interface PendingLogin {
  id: string;
  userId: string;
  attempts: number;
  challenge: string | null;
}

function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

export function purgeExpiredChallenges(now: number = Date.now()): void {
  getDB()
    .delete(authChallenges)
    .where(lt(authChallenges.expiresAt, new Date(now)))
    .run();
}

export function createPendingLogin(
  userId: string,
  now: number = Date.now(),
): { token: string; expiresAt: Date } {
  purgeExpiredChallenges(now);
  const token = newToken();
  const expiresAt = new Date(now + PENDING_LOGIN_TTL_MS);
  getDB()
    .insert(authChallenges)
    .values({ id: hashToken(token), userId, kind: "login", expiresAt })
    .run();
  return { token, expiresAt };
}

export function getPendingLogin(
  token: string | undefined,
  now: number = Date.now(),
): PendingLogin | null {
  if (!token) return null;
  const db = getDB();
  const id = hashToken(token);
  const row = db
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, "login")))
    .get();
  if (!row || !row.userId) return null;
  if (row.expiresAt.getTime() <= now) {
    db.delete(authChallenges).where(eq(authChallenges.id, id)).run();
    return null;
  }
  return {
    id,
    userId: row.userId,
    attempts: row.attempts,
    challenge: row.challenge,
  };
}

export function deletePendingLogin(id: string): void {
  getDB().delete(authChallenges).where(eq(authChallenges.id, id)).run();
}

/** Counts a failed second-factor attempt; the pending login is destroyed after too many. */
export function recordPendingFailure(pending: PendingLogin): void {
  const attempts = pending.attempts + 1;
  if (attempts >= MAX_PENDING_ATTEMPTS) {
    deletePendingLogin(pending.id);
    return;
  }
  getDB()
    .update(authChallenges)
    .set({ attempts })
    .where(eq(authChallenges.id, pending.id))
    .run();
}

export function setPendingChallenge(id: string, challenge: string): void {
  getDB()
    .update(authChallenges)
    .set({ challenge })
    .where(eq(authChallenges.id, id))
    .run();
}

/** Atomically reads and clears the stored WebAuthn challenge of a pending login. */
export function takePendingChallenge(id: string): string | null {
  return getDB().transaction(
    (tx) => {
      const row = tx
        .select({ challenge: authChallenges.challenge })
        .from(authChallenges)
        .where(eq(authChallenges.id, id))
        .get();
      if (!row?.challenge) return null;
      tx.update(authChallenges)
        .set({ challenge: null })
        .where(eq(authChallenges.id, id))
        .run();
      return row.challenge;
    },
    { behavior: "immediate" },
  );
}

export function createWebauthnChallenge(
  kind: WebauthnKind,
  userId: string | null,
  challenge: string,
  now: number = Date.now(),
): string {
  purgeExpiredChallenges(now);
  const id = crypto.randomUUID();
  getDB()
    .insert(authChallenges)
    .values({
      id,
      userId,
      kind,
      challenge,
      expiresAt: new Date(now + PASSKEY_CHALLENGE_TTL_MS),
    })
    .run();
  return id;
}

/** Single use: the row is deleted whether or not the ceremony then succeeds. */
export function takeWebauthnChallenge(
  id: string,
  kind: WebauthnKind,
  userId: string | null,
  now: number = Date.now(),
): string | null {
  return getDB().transaction(
    (tx) => {
      const row = tx
        .select()
        .from(authChallenges)
        .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, kind)))
        .get();
      if (!row) return null;
      tx.delete(authChallenges).where(eq(authChallenges.id, id)).run();
      if (row.expiresAt.getTime() <= now) return null;
      if (row.userId !== userId) return null;
      return row.challenge;
    },
    { behavior: "immediate" },
  );
}

export function setPendingCookie(
  cookies: Cookies,
  token: string,
  expiresAt: Date,
): void {
  cookies.set(PENDING_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    expires: expiresAt,
    ...cookieSecureOverride(),
  });
}

export function deletePendingCookie(cookies: Cookies): void {
  cookies.delete(PENDING_COOKIE, { path: "/", ...cookieSecureOverride() });
}
