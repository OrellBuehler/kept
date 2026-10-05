import { and, asc, count, eq, ne } from "drizzle-orm";
import {
  first,
  getDB,
  sessions,
  users,
  type UserRole,
  transaction,
} from "$lib/server/db";
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

export async function countUsers(): Promise<number> {
  const row = await first(getDB().select({ n: count() }).from(users));
  return row?.n ?? 0;
}

/** Runs inside the transaction of createUser / createFirstAdmin. */
async function insertUser(
  tx: Pick<ReturnType<typeof getDB>, "select" | "insert">,
  input: NewUser,
  passwordHash: string,
): Promise<SessionUser> {
  const username = normalizeUsername(input.username);
  const existing = await first(
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1),
  );
  if (existing) {
    throw new AuthError("username_taken", "Username is already taken.");
  }
  return (await first(
    tx
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
      }),
  ))!;
}

/**
 * Runs inside the transaction of the change, so the audit row commits or rolls
 * back with it. Log calls go through `afterCommit`.
 */
export type InTransaction<T> = (
  tx: Pick<ReturnType<typeof getDB>, "insert">,
  subject: T,
) => Promise<void>;

export async function createUser(
  input: NewUser,
  audit?: InTransaction<SessionUser>,
): Promise<SessionUser> {
  const passwordHash = await hashPassword(input.password);
  return await transaction(async (tx) => {
    const created = await insertUser(tx, input, passwordHash);
    await audit?.(tx, created);
    return created;
  });
}

/**
 * First-run setup: creates an admin only if no user exists. The check and the
 * insert share one locked transaction, so concurrent attempts cannot both win.
 */
export async function createFirstAdmin(
  input: Omit<NewUser, "role">,
): Promise<SessionUser> {
  if ((await countUsers()) > 0) {
    throw new AuthError("setup_closed", "Setup has already been completed.");
  }
  const passwordHash = await hashPassword(input.password);
  return await transaction(
    async (tx) => {
      const n =
        (await first(tx.select({ n: count() }).from(users).limit(1)))?.n ?? 0;
      if (n > 0) {
        throw new AuthError(
          "setup_closed",
          "Setup has already been completed.",
        );
      }
      return await insertUser(tx, { ...input, role: "admin" }, passwordHash);
    },
    { lock: "users:first-admin" },
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
  const row = await first(
    db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  );
  if (!row) throw new AuthError("user_not_found", "User not found.");
  if (!(await verifyPassword(current, row.passwordHash))) {
    throw new AuthError(
      "invalid_credentials",
      "Current password is incorrect.",
    );
  }
  release();
  const passwordHash = await hashPassword(next);
  await transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx
      .delete(sessions)
      .where(
        keepSessionId
          ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
          : eq(sessions.userId, userId),
      );
  });
}

export async function listUsers(): Promise<UserListEntry[]> {
  return await getDB()
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.username));
}

interface DeletableUser {
  id: string;
  username: string;
  role: UserRole;
}

function assertNotSelf(actorId: string, targetId: string): void {
  if (actorId === targetId) {
    throw new AuthError(
      "cannot_delete_self",
      "You cannot delete your own account.",
    );
  }
}

function assertDeletable(
  target: DeletableUser | undefined,
  adminCount: number,
): DeletableUser {
  if (!target) throw new AuthError("user_not_found", "User not found.");
  if (target.role === "admin" && adminCount <= 1) {
    throw new AuthError(
      "cannot_delete_last_admin",
      "The last administrator cannot be deleted.",
    );
  }
  return target;
}

/** Throws the AuthError deleteUser would; a cheap check before any credential is spent. */
export async function assertCanDeleteUser(
  actorId: string,
  targetId: string,
): Promise<DeletableUser> {
  assertNotSelf(actorId, targetId);
  const db = getDB();
  const target = await first(
    db
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1),
  );
  const admins =
    target?.role === "admin"
      ? ((
          await first(
            db
              .select({ n: count() })
              .from(users)
              .where(eq(users.role, "admin")),
          )
        )?.n ?? 0)
      : 0;
  return assertDeletable(target, admins);
}

/** `assertCanDeleteUser` inside deleteUser's transaction. */
async function assertCanDeleteUserInTx(
  tx: Pick<ReturnType<typeof getDB>, "select">,
  actorId: string,
  targetId: string,
): Promise<DeletableUser> {
  assertNotSelf(actorId, targetId);
  const target = await first(
    tx
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1),
  );
  const admins =
    target?.role === "admin"
      ? ((
          await first(
            tx
              .select({ n: count() })
              .from(users)
              .where(eq(users.role, "admin"))
              .limit(1),
          )
        )?.n ?? 0)
      : 0;
  return assertDeletable(target, admins);
}

export async function deleteUser(
  actorId: string,
  targetId: string,
  audit?: InTransaction<DeletableUser>,
): Promise<void> {
  await transaction(
    async (tx) => {
      const target = await assertCanDeleteUserInTx(tx, actorId, targetId);
      await tx.delete(users).where(eq(users.id, targetId));
      await audit?.(tx, target);
    },
    { lock: "users:admin-set" },
  );
}

export async function findUserByUsername(username: string) {
  return first(
    getDB().select().from(users).where(eq(users.username, username)).limit(1),
  );
}

export async function findUserById(id: string) {
  return first(getDB().select().from(users).where(eq(users.id, id)).limit(1));
}
