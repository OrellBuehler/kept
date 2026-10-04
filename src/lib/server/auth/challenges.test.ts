import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authChallenges } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  MAX_PENDING_ATTEMPTS,
  claimPendingAttempt,
  consumePendingLogin,
  failClaimedAttempt,
  createPendingLogin,
  createWebauthnChallenge,
  getPendingLogin,
  takePendingChallenge,
  takeWebauthnChallenge,
  setPendingChallenge,
} from "./challenges";
import { hashToken } from "./sessions";

const T0 = 1_700_000_000_000;

describe("challenges", () => {
  const ctx = useTestDB();

  async function pendingFor(userId: string) {
    const { token } = await createPendingLogin(userId, T0);
    const pending = await getPendingLogin(token, T0);
    expect(pending).not.toBeNull();
    return pending!;
  }

  it("lets parallel claims through only up to the cap", async () => {
    const u = await createTestUser();
    const pending = await pendingFor(u.id);
    const claims = await Promise.all(
      Array.from({ length: MAX_PENDING_ATTEMPTS * 3 }, () =>
        claimPendingAttempt(pending.id),
      ),
    );
    const granted = claims.filter((c) => c !== null).sort();
    expect(granted).toEqual(
      Array.from({ length: MAX_PENDING_ATTEMPTS }, (_, i) => i + 1),
    );
    expect(await ctx.db.select().from(authChallenges)).toHaveLength(0);
  });

  it("destroys the pending login when the last claimed attempt fails", async () => {
    const u = await createTestUser();
    const pending = await pendingFor(u.id);
    for (let i = 1; i < MAX_PENDING_ATTEMPTS; i++) {
      const n = await claimPendingAttempt(pending.id);
      expect(n).toBe(i);
      await failClaimedAttempt(pending.id, n!);
    }
    expect(await ctx.db.select().from(authChallenges)).toHaveLength(1);
    const last = await claimPendingAttempt(pending.id);
    await failClaimedAttempt(pending.id, last!);
    expect(await ctx.db.select().from(authChallenges)).toHaveLength(0);
  });

  it("claiming a vanished pending login yields nothing", async () => {
    expect(await claimPendingAttempt("gone")).toBeNull();
  });

  it("consumes a pending login exactly once", async () => {
    const u = await createTestUser();
    const pending = await pendingFor(u.id);
    const results = await Promise.all([
      consumePendingLogin(pending.id),
      consumePendingLogin(pending.id),
      consumePendingLogin(pending.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("hands a pending WebAuthn challenge out once, even to parallel takers", async () => {
    const u = await createTestUser();
    const pending = await pendingFor(u.id);
    await setPendingChallenge(pending.id, "chal");
    const taken = await Promise.all([
      takePendingChallenge(pending.id),
      takePendingChallenge(pending.id),
      takePendingChallenge(pending.id),
    ]);
    expect(taken.filter((c) => c === "chal")).toHaveLength(1);
    expect(taken.filter((c) => c === null)).toHaveLength(2);
  });

  it("hands a registration challenge out once, only to its owner, only while fresh", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const id = await createWebauthnChallenge("passkey_register", u.id, "c", T0);
    expect(
      await takeWebauthnChallenge(id, "passkey_register", other.id, T0),
    ).toBeNull();
    // taking it, even as the wrong user, used it up
    expect(
      await takeWebauthnChallenge(id, "passkey_register", u.id, T0),
    ).toBeNull();

    const fresh = await createWebauthnChallenge(
      "passkey_register",
      u.id,
      "c",
      T0,
    );
    const taken = await Promise.all([
      takeWebauthnChallenge(fresh, "passkey_register", u.id, T0),
      takeWebauthnChallenge(fresh, "passkey_register", u.id, T0),
    ]);
    expect(taken.filter((c) => c === "c")).toHaveLength(1);

    const stale = await createWebauthnChallenge(
      "passkey_register",
      u.id,
      "c",
      T0,
    );
    expect(
      await takeWebauthnChallenge(
        stale,
        "passkey_register",
        u.id,
        T0 + 6 * 60_000,
      ),
    ).toBeNull();
  });

  it("a pending login only resolves from its own token and expires", async () => {
    const u = await createTestUser();
    const { token } = await createPendingLogin(u.id, T0);
    expect(await getPendingLogin(undefined, T0)).toBeNull();
    expect(await getPendingLogin("not-a-token", T0)).toBeNull();
    expect((await getPendingLogin(token, T0))?.userId).toBe(u.id);
    expect(await getPendingLogin(token, T0 + 6 * 60_000)).toBeNull();
    // the expired row is removed on the way
    expect(
      await ctx.db
        .select()
        .from(authChallenges)
        .where(eq(authChallenges.id, hashToken(token))),
    ).toHaveLength(0);
  });
});
