import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  accountBalances,
  earliestDataDate,
  monthSummary,
  netWorthSeries,
  SNAPSHOT_STALE_DAYS,
} from "$lib/server/dashboard";
import { portfolioOnlyAccounts } from "$lib/server/ledger/balances";
import {
  accountValue,
  archiveAccount,
  balanceSeries,
  currentBalance,
  getAccount,
  listAccounts,
} from "$lib/server/ledger";
import {
  setCategoryDeduction,
  deductionSummary,
} from "$lib/server/tax/deductions";
import { yearReview } from "$lib/server/review/review";
import { createCategory } from "$lib/server/categories/categories";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  seedSecurity,
  seedTrade,
  seedManualPrice,
} from "$lib/testing/investments";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  makeQrr,
  QR_IBAN,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { getDB, transactions } from "$lib/server/db";
import { eq } from "drizzle-orm";
import {
  addManualContribution,
  updateDetectedContribution,
} from "./contributions";
import { closePortfolio } from "./portfolios";
import { setValues } from "./values";

useTestDB();

const TODAY = "2026-10-15";
const REF_A = makeQrr(1);
const REF_B = makeQrr(2);

async function setup() {
  const user = await createTestUser();
  const acc = await seedPillar3aAccount(user.id, {
    openingBalance: minor(1000),
  });
  const a = await seedPortfolio(user.id, acc.id, {
    name: "A",
    depositReference: REF_A,
  });
  const b = await seedPortfolio(user.id, acc.id, {
    name: "B",
    depositReference: REF_B,
  });
  return { user, acc, a, b };
}

describe("balances with portfolios", () => {
  it("is worth the latest value of each portfolio, ignoring its cash", async () => {
    const { user, acc, a, b } = await setup();
    await setValues(user.id, acc.id, "2026-01-31", [
      { portfolioId: a.id, amount: minor(10_000) },
      { portfolioId: b.id, amount: minor(20_000) },
    ]);
    await setValues(user.id, acc.id, "2026-06-30", [
      { portfolioId: a.id, amount: minor(11_000) },
    ]);
    expect(await currentBalance(user.id, acc.id, "2026-01-30")).toBe(0);
    expect(await currentBalance(user.id, acc.id, "2026-01-31")).toBe(30_000);
    expect(await currentBalance(user.id, acc.id, TODAY)).toBe(11_000 + 20_000);
    expect((await getAccount(user.id, acc.id, TODAY)).balance).toBe(31_000);
    expect((await getAccount(user.id, acc.id, TODAY)).cashBalance).toBe(0);
    expect((await listAccounts(user.id, TODAY))[0]!.balance).toBe(31_000);
    expect(await accountValue(user.id, acc.id, TODAY)).toMatchObject({
      cash: 0,
      holdings: 0,
      portfolios: 31_000,
      total: 31_000,
    });
  });

  it("ignores values dated after today", async () => {
    const { user, acc, a } = await setup();
    await setValues(user.id, acc.id, "2026-12-31", [
      { portfolioId: a.id, amount: minor(5000) },
    ]);
    expect(await currentBalance(user.id, acc.id, TODAY)).toBe(0);
  });

  it("does not count deposits twice: transactions and an opening balance are inside the portfolio values", async () => {
    const { user, acc, a } = await setup();
    await seedImportedTransaction(user.id, acc.id, {
      bookingDate: "2026-01-20",
      amount: minor(7000),
    });
    await setValues(user.id, acc.id, "2026-01-31", [
      { portfolioId: a.id, amount: minor(7100) },
    ]);
    expect(await currentBalance(user.id, acc.id, TODAY)).toBe(7100);
    expect(await currentBalance(user.id, acc.id, "2026-01-25")).toBe(0);
    expect((await listAccounts(user.id, TODAY))[0]!.balance).toBe(7100);
    expect((await accountBalances(user.id, TODAY))[0]!.balance).toBe(7100);
    const [chf] = await netWorthSeries(user.id, {
      from: "2026-01-31",
      to: "2026-01-31",
      today: TODAY,
    });
    expect(chf!.points.map((p) => p.amount)).toEqual([7100]);
    const series = await balanceSeries(
      user.id,
      acc.id,
      "2026-01-30",
      "2026-01-31",
      "day",
    );
    expect(series.map((p) => p.amount)).toEqual([0, 7100]);
  });

  it("keeps the cash behaviour of a 3a account without portfolios", async () => {
    const user = await createTestUser();
    const acc = await seedPillar3aAccount(user.id, {
      openingBalance: minor(1000),
    });
    await seedImportedTransaction(user.id, acc.id, {
      bookingDate: "2026-01-20",
      amount: minor(500),
    });
    expect(await currentBalance(user.id, acc.id, TODAY)).toBe(1500);
    expect(await accountValue(user.id, acc.id, TODAY)).toMatchObject({
      cash: 1500,
      total: 1500,
    });
  });

  it("only reports portfolio accounts of the asking user", async () => {
    const { user, acc } = await setup();
    const other = await createTestUser();
    expect([...(await portfolioOnlyAccounts(user.id, [acc.id]))]).toEqual([
      acc.id,
    ]);
    expect((await portfolioOnlyAccounts(other.id, [acc.id])).size).toBe(0);
  });

  it("counts a closed portfolio as zero from its closing date", async () => {
    const { user, acc, a, b } = await setup();
    await setValues(user.id, acc.id, "2026-01-31", [
      { portfolioId: a.id, amount: minor(10_000) },
      { portfolioId: b.id, amount: minor(20_000) },
    ]);
    await closePortfolio(user.id, b.id, {
      closedOn: "2026-09-01",
      closeReason: "wef",
    });
    expect(await currentBalance(user.id, acc.id, "2026-08-31")).toBe(30_000);
    expect(await currentBalance(user.id, acc.id, "2026-09-01")).toBe(10_000);
    expect(await currentBalance(user.id, acc.id, TODAY)).toBe(10_000);
    const series = await balanceSeries(
      user.id,
      acc.id,
      "2026-08-31",
      "2026-09-02",
      "day",
    );
    expect(series.map((p) => p.amount)).toEqual([30_000, 10_000, 10_000]);
  });

  it("ignores cash and holdings of a 3a account with portfolios", async () => {
    const { user } = await setup();
    const acc = await seedAccount(user.id, {
      type: "investment",
      name: "Inv",
      openingBalance: minor(500),
    });
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, acc.id, sec.id, {
      date: "2026-01-10",
      qty: "10",
      price: "100",
      amount: 1000,
    });
    await seedManualPrice(user.id, sec.id, "2026-10-01", "120");
    // portfolios only exist on 3a accounts, so the combined case is a 3a account that also has trades
    const mixed = await seedPillar3aAccount(user.id, {
      name: "Mixed",
      depositIban: null,
      openingBalance: minor(100),
    });
    const p = await seedPortfolio(user.id, mixed.id, { name: "M" });
    await setValues(user.id, mixed.id, "2026-02-01", [
      { portfolioId: p.id, amount: minor(7000) },
    ]);
    await seedTrade(user.id, mixed.id, sec.id, {
      date: "2026-03-10",
      qty: "5",
      price: "100",
      amount: 500,
    });
    expect(await accountValue(user.id, mixed.id, TODAY)).toMatchObject({
      cash: 0,
      holdings: 0,
      portfolios: 7000,
      total: 7000,
    });
    expect(await currentBalance(user.id, mixed.id, TODAY)).toBe(7000);
    expect(await currentBalance(user.id, acc.id, TODAY)).toBe(120_500);
  });

  it("is scoped to the user", async () => {
    const { user, acc, a } = await setup();
    await setValues(user.id, acc.id, "2026-01-31", [
      { portfolioId: a.id, amount: minor(10_000) },
    ]);
    const other = await createTestUser();
    const otherAcc = await seedPillar3aAccount(other.id);
    expect((await getAccount(other.id, otherAcc.id, TODAY)).balance).toBe(0);
    expect(
      (await netWorthSeries(other.id, { today: TODAY }))[0]!.points.every(
        (p) => p.amount === 0,
      ),
    ).toBe(true);
  });
});

describe("net worth with portfolios", () => {
  it("sums portfolio values per currency and honours closing", async () => {
    const { user, acc, a, b } = await setup();
    const cash = await seedAccount(user.id, {
      name: "Cash",
      openingBalance: minor(100),
    });
    expect(cash.id).toBeDefined();
    await setValues(user.id, acc.id, "2026-06-30", [
      { portfolioId: a.id, amount: minor(10_000) },
      { portfolioId: b.id, amount: minor(20_000) },
    ]);
    await closePortfolio(user.id, b.id, {
      closedOn: "2026-09-01",
      closeReason: "transfer",
    });
    const [chf] = await netWorthSeries(user.id, {
      from: "2026-05-31",
      to: "2026-10-31",
      today: TODAY,
    });
    expect(chf!.points.map((p) => [p.date, p.amount])).toEqual([
      ["2026-05-31", 100],
      ["2026-06-30", 30_100],
      ["2026-07-31", 30_100],
      ["2026-08-31", 30_100],
      ["2026-09-30", 10_100],
      ["2026-10-31", 10_100],
    ]);
  });

  it("counts archived accounts as zero from the archive date and includes value dates in the earliest date", async () => {
    const { user, acc, a } = await setup();
    await setValues(user.id, acc.id, "2025-03-01", [
      { portfolioId: a.id, amount: minor(10_000) },
    ]);
    expect(await earliestDataDate(user.id)).toBe("2025-03-01");
    await archiveAccount(user.id, acc.id);
    expect(await earliestDataDate(user.id)).toBe("2025-03-01");
    const points = (await netWorthSeries(user.id, { today: TODAY }))[0]!.points;
    expect(points.at(-1)!.amount).toBe(0);
  });
});

describe("staleness", () => {
  it("treats the latest portfolio value like a snapshot", async () => {
    const { user, acc, a } = await setup();
    const view = async () =>
      (await accountBalances(user.id, TODAY)).find((x) => x.id === acc.id)!;
    expect(await view()).toMatchObject({
      noData: true,
      stale: false,
      lastPortfolioValueDate: null,
    });
    await setValues(user.id, acc.id, "2026-10-01", [
      { portfolioId: a.id, amount: minor(100) },
    ]);
    expect(await view()).toMatchObject({
      noData: false,
      stale: false,
      staleDays: 14,
      lastPortfolioValueDate: "2026-10-01",
      contractNumber: "TEST-0001",
      depositIban: QR_IBAN,
    });
    await setValues(user.id, acc.id, "2026-05-01", [
      { portfolioId: a.id, amount: minor(90) },
    ]);
    // newest value still counts
    expect((await view()).staleDays).toBe(14);
    const old = await createTestUser();
    const oldAcc = await seedPillar3aAccount(old.id);
    const p = await seedPortfolio(old.id, oldAcc.id);
    await setValues(old.id, oldAcc.id, "2026-05-01", [
      { portfolioId: p.id, amount: minor(1) },
    ]);
    const v = (await accountBalances(old.id, TODAY))[0]!;
    expect(v.staleDays).toBeGreaterThan(SNAPSHOT_STALE_DAYS);
    expect(v.stale).toBe(true);
    await setValues(old.id, oldAcc.id, "2026-09-30", [
      { portfolioId: p.id, amount: minor(2) },
    ]);
    expect((await accountBalances(old.id, TODAY))[0]!.stale).toBe(false);
  });
});

describe("transfers", () => {
  it("excludes payments to a deposit IBAN or with a portfolio reference from expenses", async () => {
    const { user } = await setup();
    const current = await seedAccount(user.id, { name: "Current" });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-10-03",
      amount: minor(-7000),
      reference: REF_A,
      counterpartyIban: null,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-10-04",
      amount: minor(-3000),
      reference: null,
      counterpartyIban: QR_IBAN,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-10-05",
      amount: minor(-500),
      reference: makeQrr(900),
      counterpartyIban: null,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-10-06",
      amount: minor(100),
      reference: REF_B,
      counterpartyIban: null,
    });
    const s = await monthSummary(user.id, { month: "2026-10" });
    expect(s.totals).toEqual([
      { currency: "CHF", income: 100, expenses: 500, net: -400 },
    ]);
  });

  it("does not treat another user's deposit IBAN or reference as a transfer", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    const otherCurrent = await seedAccount(other.id);
    await seedImportedTransaction(other.id, otherCurrent.id, {
      bookingDate: "2026-10-03",
      amount: minor(-7000),
      reference: REF_A,
      counterpartyIban: QR_IBAN,
    });
    expect((await monthSummary(other.id, { month: "2026-10" })).totals).toEqual(
      [{ currency: "CHF", income: 0, expenses: 7000, net: -7000 }],
    );
    expect(user.id).not.toBe(other.id);
  });

  it("is left out of the year review, too", async () => {
    const { user } = await setup();
    const current = await seedAccount(user.id, { name: "Current" });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-03-03",
      amount: minor(-7000),
      reference: REF_A,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-03-04",
      amount: minor(-400),
      counterpartyIban: QR_IBAN,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-03-05",
      amount: minor(-100),
    });
    const review = await yearReview(user.id, { year: 2026, today: TODAY });
    expect(review.excludedTransfers).toBe(2);
    expect(review.currencies[0]).toMatchObject({ expenses: 100 });
  });
});

describe("tax deductions", () => {
  async function withCategory() {
    const { user, acc, a, b } = await setup();
    const current = await seedAccount(user.id, { name: "Current" });
    const cat = await createCategory(user.id, {
      name: "Retirement",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await setCategoryDeduction(user.id, cat.id, "pillar_3a");
    return { user, acc, a, b, current, cat };
  }

  it("lists contributions under pillar_3a even without any category mapping", async () => {
    const { user, a, b } = await setup();
    const current = await seedAccount(user.id, { name: "Current" });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-02-01",
      amount: minor(-100_000),
      reference: REF_A,
    });
    await addManualContribution(
      user.id,
      {
        portfolioId: b.id,
        date: "2026-03-01",
        amount: minor(50_000),
        kind: "ordinary",
        gapYears: [],
        note: null,
      },
      TODAY,
    );
    await addManualContribution(
      user.id,
      {
        portfolioId: a.id,
        date: "2025-03-01",
        amount: minor(9000),
        kind: "ordinary",
        gapYears: [],
        note: null,
      },
      TODAY,
    );
    const s = await deductionSummary(user.id, 2026);
    expect(s.totals).toHaveLength(1);
    expect(s.totals[0]).toMatchObject({
      type: "pillar_3a",
      currency: "CHF",
      total: 150_000,
    });
    expect(
      s.totals[0]!.lines.map((l) => [
        l.date,
        l.amount,
        l.source,
        l.label,
        l.transactionId === null,
      ]),
    ).toEqual([
      ["2026-02-01", 100_000, "pillar_3a", "A", false],
      ["2026-03-01", 50_000, "pillar_3a", "B", true],
    ]);
    expect(new Set(s.totals[0]!.lines.map((l) => l.key)).size).toBe(2);
    expect((await deductionSummary(user.id, 2025)).totals[0]!.total).toBe(9000);
    expect((await deductionSummary(user.id, 2024)).totals).toEqual([]);
  });

  it("counts a payment once when its category is mapped to pillar_3a, too", async () => {
    const { user, current, cat } = await withCategory();
    const tx = await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-02-01",
      amount: minor(-100_000),
      reference: REF_A,
      categoryId: cat.id,
    });
    await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-02-02",
      amount: minor(-2000),
      categoryId: cat.id,
    });
    const s = await deductionSummary(user.id, 2026);
    expect(s.totals).toHaveLength(1);
    expect(s.totals[0]).toMatchObject({ total: 102_000 });
    expect(
      s.totals[0]!.lines.filter((l) => l.transactionId === tx.id),
    ).toHaveLength(1);
    expect(
      s.totals[0]!.lines.find((l) => l.transactionId === tx.id),
    ).toMatchObject({
      source: "pillar_3a",
    });
  });

  it("does not resurrect a payment excluded through its category line", async () => {
    const { user, current, cat } = await withCategory();
    const tx = await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-02-01",
      amount: minor(-100_000),
      reference: REF_A,
      categoryId: cat.id,
      deductionExcluded: true,
    });
    const s = await deductionSummary(user.id, 2026);
    expect(s.totals).toEqual([]);
    expect(s.excluded.map((l) => l.transactionId)).toEqual([tx.id]);
  });

  it("honours the exclusion flag of an uncategorized detected payment", async () => {
    const { user } = await setup();
    const current = await seedAccount(user.id, { name: "Current" });
    const tx = await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-02-01",
      amount: minor(-100_000),
      reference: REF_A,
    });
    await getDB()
      .update(transactions)
      .set({ deductionExcluded: true })
      .where(eq(transactions.id, tx.id));
    const s = await deductionSummary(user.id, 2026);
    expect(s.totals).toEqual([]);
    expect(s.excluded).toHaveLength(1);
    expect(s.excluded[0]).toMatchObject({
      type: "pillar_3a",
      transactionId: tx.id,
    });
  });

  it("uses the credit date for the year and includes buy-ins", async () => {
    const { user, a } = await setup();
    const current = await seedAccount(user.id, { name: "Current" });
    const tx = await seedImportedTransaction(user.id, current.id, {
      bookingDate: "2026-12-29",
      amount: minor(-100_000),
      reference: REF_A,
    });
    await updateDetectedContribution(
      user.id,
      tx.id,
      { date: "2027-01-02", kind: "ordinary", gapYears: [], note: null },
      "2027-02-01",
    );
    expect((await deductionSummary(user.id, 2026)).totals).toEqual([]);
    expect((await deductionSummary(user.id, 2027)).totals[0]).toMatchObject({
      total: 100_000,
    });
    await addManualContribution(
      user.id,
      {
        portfolioId: a.id,
        date: "2027-01-10",
        amount: minor(200_000),
        kind: "buy_in",
        gapYears: [2025],
        note: null,
      },
      "2027-02-01",
    );
    expect((await deductionSummary(user.id, 2027)).totals[0]).toMatchObject({
      total: 300_000,
    });
  });

  it("never shows another user's contributions", async () => {
    const { user, b } = await setup();
    await addManualContribution(
      user.id,
      {
        portfolioId: b.id,
        date: "2026-03-01",
        amount: minor(50_000),
        kind: "ordinary",
        gapYears: [],
        note: null,
      },
      TODAY,
    );
    const other = await createTestUser();
    expect((await deductionSummary(other.id, 2026)).totals).toEqual([]);
  });
});
