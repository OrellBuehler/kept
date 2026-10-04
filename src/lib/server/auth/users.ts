import { and, asc, count, eq, ne } from "drizzle-orm";
import { getDB, sessions, users, type UserRole } from "$lib/server/db";
import { hashPassword, verifyPassword } from "./password";
import { passwordChangeLimiter, type LoginRateLimiter } from "./rate-limit";
import { AuthError, type SessionUser } from "./types";
import { usernameSchema } from "./schemas";

export interface NewUser {
  username: string;
  password: string;
  role: UserRole;
  displayName?: string | null;
}

export interface UserListEntry extends SessionUser {
  createdAt: Date;
}

export function normalizeUsername(username: string): string {
  return usernameSchema.parse(username);
}

export function countUsers(): number {
  return getDB().select({ n: count() }).from(users).get()?.n ?? 0;
}

function insertUser(
  tx: Pick<ReturnType<typeof getDB>, "select" | "insert">,
  input: NewUser,
  passwordHash: string,
): SessionUser {
  const username = normalizeUsername(input.username);
  const existing = tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .get();
  if (existing) {
    throw new AuthError("username_taken", "Username is already taken.");
  }
  return tx
    .insert(users)
    .values({
      username,
      passwordHash,
      role: input.role,
      displayName: input.displayName ?? null,
    })
    .returning({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
    })
    .get();
}

/** Runs inside the transaction of the change, so the audit row commits or rolls back with it. */
export type InTransaction<T> = (
  tx: Pick<ReturnType<typeof getDB>, "insert">,
  subject: T,
) => void;

export async function createUser(
  input: NewUser,
  audit?: InTransaction<SessionUser>,
): Promise<SessionUser> {
  const passwordHash = await hashPassword(input.password);
  return getDB().transaction(
    (tx) => {
      const created = insertUser(tx, input, passwordHash);
      audit?.(tx, created);
      return created;
    },
    { behavior: "immediate" },
  );
}

/**
 * First-run setup: creates an admin only if no user exists. The check and the
 * insert share one immediate transaction, so concurrent attempts cannot both win.
 */
export async function createFirstAdmin(
  input: Omit<NewUser, "role">,
): Promise<SessionUser> {
  if (countUsers() > 0) {
    throw new AuthError("setup_closed", "Setup has already been completed.");
  }
  const passwordHash = await hashPassword(input.password);
  return getDB().transaction(
    (tx) => {
      const n = tx.select({ n: count() }).from(users).get()?.n ?? 0;
      if (n > 0) {
        throw new AuthError(
          "setup_closed",
          "Setup has already been completed.",
        );
      }
      return insertUser(tx, { ...input, role: "admin" }, passwordHash);
    },
    { behavior: "immediate" },
  );
}

export async function changePassword(
  userId: string,
  current: string,
  next: string,
  keepSessionId?: string,
  limiter: LoginRateLimiter = passwordChangeLimiter,
): Promise<void> {
  const db = getDB();
  // Throws RateLimitedError after too many wrong current-password guesses.
  const release = limiter.acquireOrThrow(userId, "-");
  const row = db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) throw new AuthError("user_not_found", "User not found.");
  if (!(await verifyPassword(current, row.passwordHash))) {
    throw new AuthError(
      "invalid_credentials",
      "Current password is incorrect.",
    );
  }
  release();
  const passwordHash = await hashPassword(next);
  db.transaction((tx) => {
    tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
    tx.delete(sessions)
      .where(
        keepSessionId
          ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
          : eq(sessions.userId, userId),
      )
      .run();
  });
}

export function listUsers(): UserListEntry[] {
  return getDB()
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.username))
    .all();
}

export function deleteUser(
  actorId: string,
  targetId: string,
  audit?: InTransaction<{ id: string; username: string; role: UserRole }>,
): void {
  getDB().transaction(
    (tx) => {
      if (actorId === targetId) {
        throw new AuthError(
          "cannot_delete_self",
          "You cannot delete your own account.",
        );
      }
      const target = tx
        .select({ id: users.id, username: users.username, role: users.role })
        .from(users)
        .where(eq(users.id, targetId))
        .get();
      if (!target) throw new AuthError("user_not_found", "User not found.");
      if (target.role === "admin") {
        const admins =
          tx
            .select({ n: count() })
            .from(users)
            .where(eq(users.role, "admin"))
            .get()?.n ?? 0;
        if (admins <= 1) {
          throw new AuthError(
            "cannot_delete_last_admin",
            "The last administrator cannot be deleted.",
          );
        }
      }
      tx.delete(users).where(eq(users.id, targetId)).run();
      audit?.(tx, target);
    },
    { behavior: "immediate" },
  );
}

export function findUserByUsername(username: string) {
  return getDB().select().from(users).where(eq(users.username, username)).get();
}

export function findUserById(id: string) {
  return getDB().select().from(users).where(eq(users.id, id)).get();
}
