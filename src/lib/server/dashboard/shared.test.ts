import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  accountBalances,
  balanceTotals,
  dashboard,
  monthSummary,
  netWorthSeries,
} from "./index";

const TODAY = "2026-10-15";
const m = minor;

/**
 * Synthetic mix: a 100% account, a 50% and a 70% account in CHF (odd minor
 * units so rounding matters) and a 50% account in EUR.
 */
async function setup() {
  const user = await createTestUser();
  const full = await seedAccount(user.id, {
    name: "Full",
    openingBalance: m(100000),
    openingDate: "2026-01-01",
  });
  const half = await seedAccount(user.id, {
    name: "Half",
    openingBalance: m(50001),
    openingDate: "2026-01-01",
    shareBps: 5000,
    sharedWith: "Housemate",
  });
  const seventy = await seedAccount(user.id, {
    name: "Seventy",
    openingBalance: m(10000),
    openingDate: "2026-01-01",
    shareBps: 7000,
  });
  const euro = await seedAccount(user.id, {
    name: "Euro",
    currency: "EUR",
    openingBalance: m(2001),
    openingDate: "2026-01-01",
    shareBps: 5000,
  });
  const tx = async (
    accountId: string,
    amount: number,
    bookingDate = "2026-10-05",
    currency = "CHF",
  ) =>
    await seedImportedTransaction(user.id, accountId, {
      amount: m(amount),
      bookingDate,
      currency,
    });
  await tx(full.id, -2000);
  await tx(half.id, -3001);
  await tx(half.id, 501); // refund
  await tx(seventy.id, -1001);
  await tx(euro.id, -5, "2026-10-05", "EUR");
  await tx(half.id, -400, "2026-09-10"); // previous month
  return { user, full, half, seventy, euro };
}

describe("accounts with an ownership share", () => {
  useTestDB();

  it("stores 100% by default and exposes the share on the account views", async () => {
    const u = await createTestUser();
    const plain = await seedAccount(u.id, { name: "Plain" });
    expect(plain).toMatchObject({ shareBps: 10000, sharedWith: null });
    const shared = await seedAccount(u.id, {
      name: "Shared",
      openingBalance: m(1001),
      shareBps: 3333,
      sharedWith: "Partner",
    });
    expect(shared).toMatchObject({
      shareBps: 3333,
      sharedWith: "Partner",
      balance: 1001,
      shareBalance: 334,
    });
  });

  it("reports balances and totals at both bases", async () => {
    const { user } = await setup();
    const list = await accountBalances(user.id, TODAY);
    const by = Object.fromEntries(list.map((a) => [a.name, a]));
    expect(by.Full).toMatchObject({ balance: 98000, shareBalance: 98000 });
    // 50001 - 3001 + 501 - 400 = 47101, half = 23550.5 -> 23551
    expect(by.Half).toMatchObject({
      balance: 47101,
      shareBalance: 23551,
      shareBps: 5000,
      sharedWith: "Housemate",
    });
    expect(by.Seventy).toMatchObject({ balance: 8999, shareBalance: 6299 });
    const totals = balanceTotals(list);
    expect(totals.map((t) => t.currency)).toEqual(["CHF", "EUR"]);
    expect(totals[0]).toMatchObject({
      balance: 98000 + 47101 + 8999,
      shareBalance: 98000 + 23551 + 6299,
      accountCount: 3,
    });
    expect(totals[1]).toMatchObject({ balance: 1996, shareBalance: 998 });
  });
});

describe("netWorthSeries by basis", () => {
  useTestDB();

  it("scales each account by its share, per currency", async () => {
    const { user } = await setup();
    const opts = {
      from: "2026-09-30",
      to: TODAY,
      step: "day" as const,
      today: TODAY,
    };
    const total = await netWorthSeries(user.id, opts);
    const share = await netWorthSeries(user.id, { ...opts, basis: "share" });
    expect(share.map((s) => s.currency)).toEqual(["CHF", "EUR"]);
    expect(share[0]!.points.map((p) => p.date)).toEqual(
      total[0]!.points.map((p) => p.date),
    );
    const at = (series: typeof total, c: number, date: string) =>
      series[c]!.points.find((p) => p.date === date)!.amount;

    // 09-30: half = 50001 - 400 = 49601 -> 24801 (24800.5 rounds up)
    expect(at(total, 0, "2026-09-30")).toBe(100000 + 49601 + 10000);
    expect(at(share, 0, "2026-09-30")).toBe(100000 + 24801 + 7000);
    expect(at(total, 0, TODAY)).toBe(98000 + 47101 + 8999);
    expect(at(share, 0, TODAY)).toBe(98000 + 23551 + 6299);
    expect(at(total, 1, TODAY)).toBe(1996);
    expect(at(share, 1, TODAY)).toBe(998);
  });

  it("defaults to the total and ignores other users", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    await seedAccount(other.id, { openingBalance: m(999999), shareBps: 5000 });
    const series = await netWorthSeries(user.id, { today: TODAY });
    expect(series.at(0)!.points.at(-1)!.amount).toBe(98000 + 47101 + 8999);
    const share = await netWorthSeries(other.id, {
      today: TODAY,
      basis: "share",
    });
    expect(share[0]!.points.at(-1)!.amount).toBe(500000);
  });
});

describe("monthSummary by basis", () => {
  useTestDB();

  it("counts shared transactions at their share, refunds included", async () => {
    const { user } = await setup();
    const total = await monthSummary(user.id, { month: "2026-10" });
    const share = await monthSummary(user.id, {
      month: "2026-10",
      basis: "share",
    });
    expect(total.totals).toEqual([
      { currency: "CHF", income: 501, expenses: 6002, net: -5501 },
      { currency: "EUR", income: 0, expenses: 5, net: -5 },
    ]);
    // 3001/2 -> 1501, 1001*0.7 -> 701, 501/2 -> 251, 5/2 -> 3
    expect(share.totals).toEqual([
      { currency: "CHF", income: 251, expenses: 2000 + 1501 + 701, net: -3951 },
      { currency: "EUR", income: 0, expenses: 3, net: -3 },
    ]);
    // previous month: only the 50% account has a booking
    expect(total.previousTotals[0]).toMatchObject({ expenses: 400 });
    expect(share.previousTotals[0]).toMatchObject({ expenses: 200 });
  });

  it("keeps the own-account transfer rule at either basis", async () => {
    const user = await createTestUser();
    const a = await seedAccount(user.id, {
      iban: EXAMPLE_IBAN,
      shareBps: 5000,
    });
    const b = await seedAccount(user.id, {
      name: "B",
      iban: EXAMPLE_IBAN_OTHER,
    });
    await seedImportedTransaction(user.id, b.id, {
      amount: m(-1000),
      bookingDate: "2026-10-02",
      counterpartyIban: a.iban,
    });
    await seedImportedTransaction(user.id, a.id, {
      amount: m(300),
      bookingDate: "2026-10-03",
    });
    const share = await monthSummary(user.id, {
      month: "2026-10",
      basis: "share",
    });
    expect(share.totals).toEqual([
      { currency: "CHF", income: 150, expenses: 0, net: 150 },
    ]);
  });
});

describe("dashboard with shared accounts", () => {
  useTestDB();

  it("adds the share variants only when an account is shared", async () => {
    const { user } = await setup();
    const d = await dashboard(user.id, TODAY, { range: "3m" });
    expect(d.hasShared).toBe(true);
    expect(d.netWorth.shareSeries).not.toBeNull();
    expect(d.netWorth.shareSeries!.map((s) => s.currency)).toEqual([
      "CHF",
      "EUR",
    ]);
    expect(d.netWorth.totals[0]).toMatchObject({
      balance: 154100,
      shareBalance: 127850,
    });
    expect(d.month.totals[0]).toMatchObject({ expenses: 6002 });
    expect(d.shareMonth!.totals[0]).toMatchObject({ expenses: 4202 });
    expect(d.spendingTotal).not.toBeNull();
    expect(d.accounts.find((a) => a.name === "Half")).toMatchObject({
      shareBps: 5000,
    });
  });

  it("is unchanged for users without shared accounts", async () => {
    const user = await createTestUser();
    await seedAccount(user.id, { openingBalance: m(1000) });
    const d = await dashboard(user.id, TODAY);
    expect(d.hasShared).toBe(false);
    expect(d.netWorth.shareSeries).toBeNull();
    expect(d.shareMonth).toBeNull();
    expect(d.spendingTotal).toBeNull();
    expect(d.netWorth.totals[0]).toMatchObject({
      balance: 1000,
      shareBalance: 1000,
    });
  });

  it("does not count an archived shared account", async () => {
    const user = await createTestUser();
    const a = await seedAccount(user.id, { shareBps: 5000 });
    const { archiveAccount } = await import("$lib/server/ledger");
    await archiveAccount(user.id, a.id);
    expect((await dashboard(user.id, TODAY)).hasShared).toBe(false);
  });
});
