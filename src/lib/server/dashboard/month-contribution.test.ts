import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { yearReview } from "$lib/server/review";
import { monthSummary } from "./month";

useTestDB();

const REF = makeQrr(3);

async function setup() {
  const user = await createTestUser();
  const threeA = await seedPillar3aAccount(user.id);
  await seedPortfolio(user.id, threeA.id, { depositReference: REF });
  const current = await seedAccount(user.id, { name: "Current" });
  const row = (over: Parameters<typeof seedImportedTransaction>[2]) =>
    seedImportedTransaction(user.id, current.id, {
      reference: REF,
      amount: minor(-100_000),
      currency: "CHF",
      bookingDate: "2026-02-10",
      ...over,
    });
  return { user, row };
}

describe("contribution payments in summaries", () => {
  it("monthSummary leaves out a paying row and counts a mirror row", async () => {
    const { user, row } = await setup();
    await row({});
    await row({ source: "mirror", amount: minor(-40_000) });
    const s = await monthSummary(user.id, { month: "2026-02" });
    expect(s.totals).toEqual([
      { currency: "CHF", income: 0, expenses: 40_000, net: -40_000 },
    ]);
  });

  it("yearReview leaves out a paying row and counts a mirror row", async () => {
    const { user, row } = await setup();
    await row({});
    await row({ source: "mirror", amount: minor(-40_000) });
    const r = await yearReview(user.id, { year: 2026, today: "2026-12-31" });
    expect(r.excludedTransfers).toBe(1);
  });
});
