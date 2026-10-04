import { describeError } from "$lib/server/errors";
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch (err) {
    // A corrupt stored hash must not authenticate; treat it as a mismatch.
    console.error(
      "Password verification failed on a malformed hash:",
      describeError(err),
    );
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Verify against a throwaway hash so unknown usernames cost the same as
 * known ones.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  await verifyPassword(password, await warmDummyHash());
}

/** Compute the dummy hash up front (called from init) so the first unknown-user login is not faster or slower. */
export function warmDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomUUID());
  return dummyHash;
}
