import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { first, sessions, users } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies } from "$lib/testing/event";
import {
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
  createSession,
  deleteSessionCookie,
  hashToken,
  invalidateSession,
  invalidateUserSessions,
  purgeExpiredSessions,
  setSessionCookie,
  validateSessionToken,
} from "./sessions";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe("sessions", () => {
  const ctx = useTestDB();

  it("stores only the hash of the token", async () => {
    const user = await createTestUser();
    const { token, session } = await createSession(user.id, T0);
    const rows = await ctx.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(hashToken(token));
    expect(rows[0].id).not.toBe(token);
    expect(session.id).toBe(rows[0].id);
    expect(rows[0].expiresAt.getTime()).toBe(T0 + SESSION_LIFETIME_MS);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("validates a fresh session without refreshing", async () => {
    const user = await createTestUser({ role: "admin", displayName: "Ada" });
    const { token } = await createSession(user.id, T0);
    const v = await validateSessionToken(token, T0 + DAY);
    expect(v?.user).toEqual({
      id: user.id,
      username: user.username,
      displayName: "Ada",
      role: "admin",
    });
    expect(v?.refreshed).toBe(false);
  });

  it("rejects unknown tokens", async () => {
    expect(await validateSessionToken("nope", T0)).toBeNull();
  });

  it("extends the session when less than 15 days remain", async () => {
    const user = await createTestUser();
    const { token, session } = await createSession(user.id, T0);
    const later = T0 + 16 * DAY;
    const v = await validateSessionToken(token, later);
    expect(v?.refreshed).toBe(true);
    expect(v?.session.expiresAt.getTime()).toBe(later + SESSION_LIFETIME_MS);
    const row = await first(
      ctx.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .limit(1),
    );
    expect(row?.expiresAt.getTime()).toBe(later + SESSION_LIFETIME_MS);
  });

  it("does not extend at exactly 15 days remaining", async () => {
    const user = await createTestUser();
    const { token } = await createSession(user.id, T0);
    expect((await validateSessionToken(token, T0 + 15 * DAY))?.refreshed).toBe(
      false,
    );
  });

  it("rejects and deletes expired sessions", async () => {
    const user = await createTestUser();
    const { token } = await createSession(user.id, T0);
    expect(
      await validateSessionToken(token, T0 + SESSION_LIFETIME_MS),
    ).toBeNull();
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
  });

  it("invalidates a single session", async () => {
    const user = await createTestUser();
    const a = await createSession(user.id, T0);
    const b = await createSession(user.id, T0);
    await invalidateSession(a.session.id);
    expect(await validateSessionToken(a.token, T0)).toBeNull();
    expect(await validateSessionToken(b.token, T0)).not.toBeNull();
  });

  it("invalidates all of a user's sessions except one, never touching others", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const a1 = await createSession(alice.id, T0);
    const a2 = await createSession(alice.id, T0);
    const b1 = await createSession(bob.id, T0);
    await invalidateUserSessions(alice.id, a1.session.id);
    expect(await validateSessionToken(a1.token, T0)).not.toBeNull();
    expect(await validateSessionToken(a2.token, T0)).toBeNull();
    expect(await validateSessionToken(b1.token, T0)).not.toBeNull();
    await invalidateUserSessions(alice.id);
    expect(await validateSessionToken(a1.token, T0)).toBeNull();
    expect(await validateSessionToken(b1.token, T0)).not.toBeNull();
  });

  it("purges expired sessions", async () => {
    const user = await createTestUser();
    await createSession(user.id, T0);
    const live = await createSession(user.id, T0 + 10 * DAY);
    await purgeExpiredSessions(T0 + SESSION_LIFETIME_MS + 1);
    const rows = await ctx.db.select().from(sessions);
    expect(rows.map((r) => r.id)).toEqual([live.session.id]);
  });

  it("deleting a user cascades to sessions", async () => {
    const user = await createTestUser();
    await createSession(user.id, T0);
    await ctx.db.delete(users).where(eq(users.id, user.id));
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
  });
});

describe("session cookie", () => {
  it("is httpOnly, lax, path / and uses the default secure behaviour", () => {
    const cookies = new FakeCookies();
    const expires = new Date(T0);
    setSessionCookie(cookies as never, "tok", expires);
    expect(cookies.get(SESSION_COOKIE)).toBe("tok");
    expect(cookies.options(SESSION_COOKIE)).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires,
    });
  });

  it("honours KEPT_COOKIE_SECURE=false", () => {
    process.env.KEPT_COOKIE_SECURE = "false";
    try {
      const cookies = new FakeCookies();
      setSessionCookie(cookies as never, "tok", new Date(T0));
      expect(cookies.options(SESSION_COOKIE)?.secure).toBe(false);
    } finally {
      delete process.env.KEPT_COOKIE_SECURE;
    }
  });

  it("deletes the cookie", () => {
    const cookies = new FakeCookies({ [SESSION_COOKIE]: "tok" });
    deleteSessionCookie(cookies as never);
    expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});
