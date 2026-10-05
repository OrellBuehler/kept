import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { getDB, transfers } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { loadTransferExclusion } from "./exclusion";

useTestDB();

const REF = makeQrr(7);

async function setup() {
  const user = await createTestUser();
  const threeA = await seedPillar3aAccount(user.id);
  await seedPortfolio(user.id, threeA.id, { depositReference: REF });
  const current = await seedAccount(user.id, { name: "Current" });
  const t = await seedImportedTransaction(user.id, current.id, {
    reference: REF,
    amount: minor(-100_000),
    currency: "CHF",
    bookingDate: "2026-02-01",
  });
  return { user, threeA, current, t };
}

describe("loadTransferExclusion reference heuristic", () => {
  it("treats a payment with a deposit reference as a transfer", async () => {
    const { user, t } = await setup();
    const exclusion = await loadTransferExclusion(user.id);
    expect(exclusion.isTransfer(t)).toBe(true);
  });

  it("honours a dismissal: not a transfer", async () => {
    const { user, t, current, threeA } = await setup();
    await getDB().insert(transfers).values({
      userId: user.id,
      outTransactionId: t.id,
      inTransactionId: null,
      status: "dismissed",
      method: "manual",
      fromAccountId: current.id,
      toAccountId: threeA.id,
    });
    const exclusion = await loadTransferExclusion(user.id);
    expect(exclusion.isTransfer(t)).toBe(false);
  });

  it("ignores a mirror row when the source is known", async () => {
    const { user, t } = await setup();
    const exclusion = await loadTransferExclusion(user.id);
    expect(exclusion.isTransfer({ ...t, source: "mirror" })).toBe(false);
  });

  it("does not see another user's references", async () => {
    const { t } = await setup();
    const other = await createTestUser();
    const exclusion = await loadTransferExclusion(other.id);
    expect(exclusion.isTransfer(t)).toBe(false);
  });
});
