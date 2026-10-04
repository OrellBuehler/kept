import type { Cookies } from "@sveltejs/kit";
import { and, eq, lt, ne } from "drizzle-orm";
import { getDB, sessions, users } from "$lib/server/db";
import type { SessionInfo, SessionUser } from "./types";

export const SESSION_COOKIE = "kept_session";
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_REFRESH_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

export function createSession(
  userId: string,
  now: number = Date.now(),
): { token: string; session: SessionInfo } {
  const token = generateToken();
  const id = hashToken(token);
  const expiresAt = new Date(now + SESSION_LIFETIME_MS);
  getDB().insert(sessions).values({ id, userId, expiresAt }).run();
  return { token, session: { id, expiresAt } };
}

export interface ValidatedSession {
  user: SessionUser;
  session: SessionInfo;
  /** True when the expiry was extended and the cookie should be re-issued. */
  refreshed: boolean;
}

export function validateSessionToken(
  token: string,
  now: number = Date.now(),
): ValidatedSession | null {
  const db = getDB();
  const id = hashToken(token);
  const row = db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;

  if (row.expiresAt.getTime() <= now) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }

  let expiresAt = row.expiresAt;
  let refreshed = false;
  if (expiresAt.getTime() - now < SESSION_REFRESH_THRESHOLD_MS) {
    expiresAt = new Date(now + SESSION_LIFETIME_MS);
    db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
    refreshed = true;
  }

  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    },
    session: { id, expiresAt },
    refreshed,
  };
}

export function invalidateSession(sessionId: string): void {
  getDB().delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function invalidateUserSessions(
  userId: string,
  exceptSessionId?: string,
): void {
  getDB()
    .delete(sessions)
    .where(
      exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId),
    )
    .run();
}

export function purgeExpiredSessions(now: number = Date.now()): void {
  getDB()
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now)))
    .run();
}

export function cookieSecureOverride():
  { secure: false } | Record<string, never> {
  return process.env.KEPT_COOKIE_SECURE === "false" ? { secure: false } : {};
}

export function setSessionCookie(
  cookies: Cookies,
  token: string,
  expiresAt: Date,
): void {
  cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    expires: expiresAt,
    ...cookieSecureOverride(),
  });
}

/** Set-Cookie header value that clears the session cookie, for responses built outside `resolve`. */
export function clearedSessionCookieHeader(cookies: Cookies): string {
  return cookies.serialize(SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    expires: new Date(0),
    ...cookieSecureOverride(),
  });
}

export function deleteSessionCookie(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE, {
    path: "/",
    ...cookieSecureOverride(),
  });
}
