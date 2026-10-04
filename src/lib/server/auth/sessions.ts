import type { Cookies } from "@sveltejs/kit";
import { and, eq, lt, ne } from "drizzle-orm";
import { first, getDB, sessions, users } from "$lib/server/db";
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

export async function createSession(
  userId: string,
  now: number = Date.now(),
): Promise<{ token: string; session: SessionInfo }> {
  const token = generateToken();
  const id = hashToken(token);
  const expiresAt = new Date(now + SESSION_LIFETIME_MS);
  await getDB().insert(sessions).values({ id, userId, expiresAt });
  return { token, session: { id, expiresAt } };
}

export interface ValidatedSession {
  user: SessionUser;
  session: SessionInfo;
  /** True when the expiry was extended and the cookie should be re-issued. */
  refreshed: boolean;
}

export async function validateSessionToken(
  token: string,
  now: number = Date.now(),
): Promise<ValidatedSession | null> {
  const db = getDB();
  const id = hashToken(token);
  const row = await first(
    db
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
      .limit(1),
  );
  if (!row) return null;

  if (row.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  let expiresAt = row.expiresAt;
  let refreshed = false;
  if (expiresAt.getTime() - now < SESSION_REFRESH_THRESHOLD_MS) {
    expiresAt = new Date(now + SESSION_LIFETIME_MS);
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
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

export async function invalidateSession(sessionId: string): Promise<void> {
  await getDB().delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * The delete of a user's sessions as an unexecuted query, so a synchronous
 * transaction body can `.run()` it on its `tx` while everything else awaits it.
 */
export function userSessionsDelete(
  db: Pick<ReturnType<typeof getDB>, "delete">,
  userId: string,
  exceptSessionId?: string,
) {
  return db
    .delete(sessions)
    .where(
      exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId),
    );
}

export async function invalidateUserSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await userSessionsDelete(getDB(), userId, exceptSessionId);
}

export async function purgeExpiredSessions(
  now: number = Date.now(),
): Promise<void> {
  await getDB()
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now)));
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
