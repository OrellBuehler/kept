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
import { archiveAccount } from "$lib/server/ledger";
import { addManualContribution } from "./contributions";
import { pillar3aOverview } from "./overview";
import { closePortfolio } from "./portfolios";
import { setValues } from "./values";
import { setYearSetting } from "./years";

useTestDB();

const TODAY = "2027-03-01";
const REF_A = makeQrr(1);
const REF_B = makeQrr(2);

async function setup() {
  const user = await createTestUser();
  const acc = await seedPillar3aAccount(user.id);
  const a = await seedPortfolio(user.id, acc.id, {
    name: "A",
    strategy: "Global 100",
    depositReference: REF_A,
  });
  const b = await seedPortfolio(user.id, acc.id, {
    name: "B",
    depositReference: REF_B,
  });
  const current = await seedAccount(user.id, { name: "Current" });
  return { user, acc, a, b, current };
}

const manual = (
  portfolioId: string,
  date: string,
  amount: number,
  extra: { kind?: "ordinary" | "buy_in"; gapYears?: number[] } = {},
) => ({
  portfolioId,
  date,
  amount: minor(amount),
  kind: extra.kind ?? ("ordinary" as const),
  gapYears: extra.gapYears ?? [],
  note: null,
});

describe("pillar3aOverview", () => {
  it("is empty and lists the running year for a new user", async () => {
    const user = await createTestUser();
    const o = await pillar3aOverview(user.id, TODAY);
    expect(o.years.map((y) => y.year)).toEqual([2027, 2026, 2025]);
    expect(o.years[0]).toMatchObject({
      deduction: "small",
      settingInherited: true,
      limit: 725_800,
      limitUnconfirmed: true,
      ordinary: 0,
      gap: 725_800,
      buyInEligible: false,
    });
    expect(o.portfolios).toEqual([]);
    expect(o.totals).toEqual({
      value: 0,
      contributed: 0,
      gain: 0,
      accountsValue: 0,
    });
    expect(o.ageBenefitDrawn).toBe(false);
  });

  it("sums years, marks gaps and buy-ins", async () => {
    const { user, a, b, current } = await setup();
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2025-05-01",
      amount: minor(-725_800),
      reference: REF_A,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-02-01",
      amount: minor(-300_000),
      reference: REF_B,
    });
    await addManualContribution(
      user.id,
      manual(a.id, "2027-01-10", 200_000, { kind: "buy_in", gapYears: [2026] }),
      TODAY,
    );
    await setYearSetting(user.id, {
      year: 2027,
      deduction: "large",
      earnedIncome: minor(5_000_000),
    });
    const o = await pillar3aOverview(user.id, TODAY);
    const byYear = new Map(o.years.map((y) => [y.year, y]));
    expect(byYear.get(2025)).toMatchObject({
      ordinary: 725_800,
      gap: 0,
      buyInEligible: false,
      closedBy: null,
    });
    expect(byYear.get(2026)).toMatchObject({
      ordinary: 300_000,
      gap: 425_800,
      buyInEligible: false,
      closedBy: expect.any(String),
    });
    expect(byYear.get(2027)).toMatchObject({
      deduction: "large",
      settingInherited: false,
      limit: 1_000_000,
      limitUnconfirmed: true,
      buyIn: 200_000,
      ordinary: 0,
    });
    expect(o.gaps.map((g) => [g.year, g.gap, g.closedBy !== null])).toEqual([
      [2025, 0, false],
      [2026, 425_800, true],
    ]);
    expect(b.id).toBeDefined();
  });

  it("flags open gap years as eligible and reports over-limit payments", async () => {
    const { user, a } = await setup();
    await addManualContribution(
      user.id,
      manual(a.id, "2025-05-01", 100_000),
      TODAY,
    );
    await addManualContribution(
      user.id,
      manual(a.id, "2026-05-01", 800_000),
      TODAY,
    );
    const byYear = new Map(
      (await pillar3aOverview(user.id, TODAY)).years.map((y) => [y.year, y]),
    );
    expect(byYear.get(2025)).toMatchObject({
      gap: 625_800,
      buyInEligible: true,
    });
    expect(byYear.get(2026)).toMatchObject({
      gap: 0,
      overLimit: 74_200,
      buyInEligible: false,
    });
  });

  it("includes years before 2025 that have contributions", async () => {
    const { user, a } = await setup();
    await addManualContribution(
      user.id,
      manual(a.id, "2024-05-01", 100_000),
      TODAY,
    );
    const o = await pillar3aOverview(user.id, TODAY);
    expect(o.years.map((y) => y.year)).toEqual([2027, 2026, 2025, 2024]);
    expect(o.years[3]).toMatchObject({
      limit: 705_600,
      limitUnconfirmed: false,
      buyInEligible: false,
    });
  });

  it("computes value, contributed and gain per portfolio and in total", async () => {
    const { user, acc, a, b } = await setup();
    await addManualContribution(
      user.id,
      manual(a.id, "2026-05-01", 100_000),
      TODAY,
    );
    await addManualContribution(
      user.id,
      manual(a.id, "2026-06-01", 50_000),
      TODAY,
    );
    await addManualContribution(
      user.id,
      manual(b.id, "2026-06-01", 40_000),
      TODAY,
    );
    await setValues(user.id, acc.id, "2026-12-31", [
      { portfolioId: a.id, amount: minor(170_000) },
      { portfolioId: b.id, amount: minor(39_000) },
    ]);
    await setValues(user.id, acc.id, "2027-06-30", [
      { portfolioId: a.id, amount: minor(999_999) },
    ]);
    const o = await pillar3aOverview(user.id, TODAY);
    expect(
      o.portfolios.map((p) => [
        p.name,
        p.latestValue,
        p.latestValueDate,
        p.contributed,
        p.gain,
      ]),
    ).toEqual([
      ["A", 170_000, "2026-12-31", 150_000, 20_000],
      ["B", 39_000, "2026-12-31", 40_000, -1000],
    ]);
    expect(o.totals).toEqual({
      value: 209_000,
      contributed: 190_000,
      gain: 19_000,
      accountsValue: 209_000,
    });
  });

  it("keeps closed portfolios out of the totals but reports them", async () => {
    const { user, acc, a, b } = await setup();
    await addManualContribution(
      user.id,
      manual(a.id, "2026-05-01", 100_000),
      TODAY,
    );
    await addManualContribution(
      user.id,
      manual(b.id, "2026-05-01", 40_000),
      TODAY,
    );
    await setValues(user.id, acc.id, "2026-12-31", [
      { portfolioId: a.id, amount: minor(110_000) },
      { portfolioId: b.id, amount: minor(45_000) },
    ]);
    await closePortfolio(user.id, b.id, {
      closedOn: "2027-01-31",
      closeReason: "age",
    });
    const o = await pillar3aOverview(user.id, TODAY);
    expect(o.portfolios.map((p) => [p.name, p.closeReason, p.gain])).toEqual([
      ["A", null, 10_000],
      ["B", "age", 5000],
    ]);
    expect(o.totals).toMatchObject({
      value: 110_000,
      contributed: 100_000,
      gain: 10_000,
    });
    expect(o.ageBenefitDrawn).toBe(true);
  });

  it("is scoped to the user", async () => {
    const { user, acc, a } = await setup();
    await addManualContribution(
      user.id,
      manual(a.id, "2026-05-01", 100_000),
      TODAY,
    );
    await setValues(user.id, acc.id, "2026-12-31", [
      { portfolioId: a.id, amount: minor(1) },
    ]);
    const other = await createTestUser();
    await seedPillar3aAccount(other.id);
    const o = await pillar3aOverview(other.id, TODAY);
    expect(o.portfolios).toEqual([]);
    expect(o.totals).toEqual({
      value: 0,
      contributed: 0,
      gain: 0,
      accountsValue: 0,
    });
    expect(o.years.every((y) => y.ordinary === 0)).toBe(true);
  });

  it("leaves archived accounts out of the totals but keeps their contributions", async () => {
    const { user, acc, a } = await setup();
    const other = await seedPillar3aAccount(user.id, { name: "Other 3a" });
    const c = await seedPortfolio(user.id, other.id, { name: "C" });
    await setValues(user.id, acc.id, "2027-01-01", [
      { portfolioId: a.id, amount: minor(100_000) },
    ]);
    await setValues(user.id, other.id, "2027-01-01", [
      { portfolioId: c.id, amount: minor(50_000) },
    ]);
    await addManualContribution(
      user.id,
      manual(a.id, "2027-01-10", 60_000),
      TODAY,
    );
    await addManualContribution(
      user.id,
      manual(c.id, "2027-01-11", 40_000),
      TODAY,
    );
    await archiveAccount(user.id, other.id);

    const o = await pillar3aOverview(user.id, TODAY);
    expect(o.portfolios.find((p) => p.portfolioId === c.id)).toMatchObject({
      archived: true,
      latestValue: 50_000,
    });
    expect(o.portfolios.find((p) => p.portfolioId === a.id)?.archived).toBe(
      false,
    );
    expect(o.totals).toMatchObject({
      value: 100_000,
      contributed: 60_000,
      gain: 40_000,
      accountsValue: 100_000,
    });
    expect(o.years[0]!.ordinary).toBe(100_000);
  });
});
