import { createSession } from "$lib/server/auth/sessions";
import type { SessionUser } from "$lib/server/auth/types";
import { createUser } from "$lib/server/auth/users";
import type { UserRole } from "$lib/server/db";

export const TEST_PASSWORD = "correct-horse-battery";

let counter = 0;

export interface TestUser extends SessionUser {
  password: string;
}

/** Creates a real user row. Usernames are unique per call unless given. */
export async function createTestUser(
  opts: {
    username?: string;
    role?: UserRole;
    password?: string;
    displayName?: string | null;
  } = {},
): Promise<TestUser> {
  const password = opts.password ?? TEST_PASSWORD;
  const user = await createUser({
    username: opts.username ?? `user${++counter}`,
    password,
    role: opts.role ?? "member",
    displayName: opts.displayName ?? null,
  });
  return { ...user, password };
}

/** A logged-in browser stand-in: real session row plus its token. */
export function loginTestUser(user: SessionUser) {
  return createSession(user.id);
}
