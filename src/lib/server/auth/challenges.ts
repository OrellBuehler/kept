import type { Cookies } from "@sveltejs/kit";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  authChallenges,
  first,
  getDB,
  type AuthChallengeKind,
  transaction,
} from "$lib/server/db";
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

export async function purgeExpiredChallenges(
  now: number = Date.now(),
): Promise<void> {
  await getDB()
    .delete(authChallenges)
    .where(lt(authChallenges.expiresAt, new Date(now)));
}

export async function createPendingLogin(
  userId: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: Date }> {
  await purgeExpiredChallenges(now);
  const token = newToken();
  const expiresAt = new Date(now + PENDING_LOGIN_TTL_MS);
  await getDB()
    .insert(authChallenges)
    .values({ id: hashToken(token), userId, kind: "login", expiresAt });
  return { token, expiresAt };
}

export async function getPendingLogin(
  token: string | undefined,
  now: number = Date.now(),
): Promise<PendingLogin | null> {
  if (!token) return null;
  const db = getDB();
  const id = hashToken(token);
  const row = await first(
    db
      .select()
      .from(authChallenges)
      .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, "login")))
      .limit(1),
  );
  if (!row || !row.userId) return null;
  if (row.expiresAt.getTime() <= now) {
    await db.delete(authChallenges).where(eq(authChallenges.id, id));
    return null;
  }
  return {
    id,
    userId: row.userId,
    attempts: row.attempts,
    challenge: row.challenge,
  };
}

export async function deletePendingLogin(id: string): Promise<void> {
  await getDB().delete(authChallenges).where(eq(authChallenges.id, id));
}

/**
 * Claims one second-factor attempt before the code is checked. The cap is
 * enforced by the UPDATE itself, so N parallel guesses (from any address) can
 * claim at most MAX_PENDING_ATTEMPTS attempts between them; the rest get null.
 * An exhausted pending login is deleted. Returns the claimed attempt number.
 */
export async function claimPendingAttempt(id: string): Promise<number | null> {
  const db = getDB();
  const [row] = await db
    .update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(
      and(
        eq(authChallenges.id, id),
        eq(authChallenges.kind, "login"),
        lt(authChallenges.attempts, MAX_PENDING_ATTEMPTS),
      ),
    )
    .returning({ attempts: authChallenges.attempts });
  if (row) return row.attempts;
  await db
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.id, id),
        gte(authChallenges.attempts, MAX_PENDING_ATTEMPTS),
      ),
    );
  return null;
}

/** A claimed attempt turned out wrong; the pending login is destroyed once the cap is reached. */
export async function failClaimedAttempt(
  id: string,
  claimed: number,
): Promise<void> {
  if (claimed >= MAX_PENDING_ATTEMPTS) await deletePendingLogin(id);
}

/**
 * Consumes the pending login after a successful second factor. True for exactly
 * one caller: of two parallel valid factors only the one that removes the row
 * may go on to create a session.
 */
export async function consumePendingLogin(id: string): Promise<boolean> {
  const rows = await getDB()
    .delete(authChallenges)
    .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, "login")))
    .returning({ id: authChallenges.id });
  return rows.length === 1;
}

export async function setPendingChallenge(
  id: string,
  challenge: string,
): Promise<void> {
  await getDB()
    .update(authChallenges)
    .set({ challenge })
    .where(eq(authChallenges.id, id));
}

/** Atomically reads and clears the stored WebAuthn challenge of a pending login. */
export async function takePendingChallenge(id: string): Promise<string | null> {
  return await transaction(async (tx) => {
    const row = await first(
      tx
        .select({ challenge: authChallenges.challenge })
        .from(authChallenges)
        .where(eq(authChallenges.id, id))
        .limit(1),
    );
    if (!row?.challenge) return null;
    await tx
      .update(authChallenges)
      .set({ challenge: null })
      .where(eq(authChallenges.id, id));
    return row.challenge;
  });
}

export async function createWebauthnChallenge(
  kind: WebauthnKind,
  userId: string | null,
  challenge: string,
  now: number = Date.now(),
): Promise<string> {
  await purgeExpiredChallenges(now);
  const id = crypto.randomUUID();
  await getDB()
    .insert(authChallenges)
    .values({
      id,
      userId,
      kind,
      challenge,
      expiresAt: new Date(now + PASSKEY_CHALLENGE_TTL_MS),
    });
  return id;
}

/** Single use: the row is deleted whether or not the ceremony then succeeds. */
export async function takeWebauthnChallenge(
  id: string,
  kind: WebauthnKind,
  userId: string | null,
  now: number = Date.now(),
): Promise<string | null> {
  return await transaction(async (tx) => {
    const row = await first(
      tx
        .select()
        .from(authChallenges)
        .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, kind)))
        .limit(1),
    );
    if (!row) return null;
    await tx.delete(authChallenges).where(eq(authChallenges.id, id));
    if (row.expiresAt.getTime() <= now) return null;
    if (row.userId !== userId) return null;
    return row.challenge;
  });
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
