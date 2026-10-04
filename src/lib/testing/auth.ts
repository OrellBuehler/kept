import { totpCode } from "$lib/server/auth/totp";
import {
  confirmTotpEnrolment,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { getDB, passkeys } from "$lib/server/db";
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
export async function loginTestUser(user: SessionUser) {
  return await createSession(user.id);
}

/** Switches an authenticator app on for the user; returns the recovery codes (single use, time independent). */
export async function enableTotp(user: {
  id: string;
  username: string;
}): Promise<string[]> {
  const { secret } = await startTotpEnrolment(user.id, user.username);
  return await confirmTotpEnrolment(user.id, totpCode(secret, Date.now()));
}

/** Registers a dummy passkey row (never used to sign in) so the user counts as having one. */
export async function addPasskey(userId: string): Promise<void> {
  await getDB()
    .insert(passkeys)
    .values({
      userId,
      name: "test key",
      credentialId: `cred-${crypto.randomUUID()}`,
      publicKey: "pk",
      deviceType: "singleDevice",
      backedUp: false,
    });
}
