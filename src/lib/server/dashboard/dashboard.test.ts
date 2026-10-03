import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { allocate } from "$lib/server/bills/allocations";
import { createSnapshot } from "$lib/server/ledger";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
  FOREIGN_IBANS,
  EXAMPLE_SCOR,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  seedAccount,
  seedImport,
  seedImportedTransaction,
} from "$lib/testing/ledger";
import {
  accountBalances,
  billsSummary,
  dashboard,
  earliestDataDate,
  lastImports,
  monthSummary,
  netWorthSeries,
  overdueBillCount,
  parseRange,
  rangeWindow,
  unmatchedTransactions,
} from "./index";
import { addDays, addMonths, stepDates } from "./dates";

const TODAY = "2026-10-15";
const m = minor;

describe("dates", () => {
  it("adds months with end-of-month clamping", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -12)).toBe("2025-01-15");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });

  it("steps weekly back from the end date", () => {
    expect(stepDates("2026-10-01", "2026-10-15", "week")).toEqual([
      "2026-10-01",
      "2026-10-08",
      "2026-10-15",
    ]);
    expect(stepDates("2026-10-02", "2026-10-15", "week")).toEqual([
      "2026-10-08",
      "2026-10-15",
    ]);
  });

  it("parses ranges with a 12 month fallback", () => {
    expect(parseRange("3m")).toBe("3m");
    expect(parseRange("all")).toBe("all");
    expect(parseRange("forever")).toBe("12m");
    expect(parseRange(null)).toBe("12m");
    expect(rangeWindow("12m", TODAY, null)).toEqual({
      from: "2025-10-15",
      to: TODAY,
      step: "month",
    });
    expect(rangeWindow("3m", TODAY, null).step).toBe("week");
    expect(rangeWindow("all", TODAY, "2024-02-10")).toEqual({
      from: "2024-02-10",
      to: TODAY,
      step: "month",
    });
    expect(rangeWindow("all", TODAY, null).from).toBe(TODAY);
    expect(rangeWindow("all", TODAY, "0001-01-01").from).toBe("1976-10-15");
    expect(rangeWindow("all", TODAY, "2999-01-01").from).toBe(TODAY);
  });
});

describe("netWorthSeries", () => {
  useTestDB();

  it("sums accounts per currency, including snapshot-only accounts", async () => {
    const u = await createTestUser();
    const current = seedAccount(u.id, {
      name: "Current",
      openingBalance: m(100000),
      openingDate: "2026-01-01",
    });
    seedImportedTransaction(u.id, current.id, {
      bookingDate: "2026-08-10",
      amount: m(-2500),
    });
    const pension = seedAccount(u.id, { name: "Pension", type: "pension" });
    createSnapshot(u.id, pension.id, {
      date: "2026-06-30",
      amount: m(500000),
      note: null,
    } as never);
    const euro = seedAccount(u.id, {
      name: "Euro",
      currency: "EUR",
      openingBalance: m(3000),
      openingDate: "2026-01-01",
    });
    seedImportedTransaction(u.id, euro.id, {
      bookingDate: "2026-09-02",
      amount: m(1000),
      currency: "EUR",
    });

    const series = netWorthSeries(u.id, { today: TODAY });
    expect(series.map((s) => s.currency)).toEqual(["CHF", "EUR"]);
    const chf = series[0]!;
    expect(chf.points).toHaveLength(13);
    expect(chf.points.at(-1)!.date).toBe(TODAY);
    const at = (date: string) =>
      chf.points.find((p) => p.date === date)?.amount;
    // before the pension snapshot only the current account counts
    expect(at("2026-05-31")).toBe(100000);
    expect(at("2026-06-30")).toBe(600000);
    expect(at("2026-08-31")).toBe(597500);
    expect(chf.points.at(-1)!.amount).toBe(597500);
    const eur = series[1]!;
    expect(eur.points.at(-1)!.amount).toBe(4000);
    expect(eur.points.every((p, i) => p.date === chf.points[i]!.date)).toBe(
      true,
    );
  });

  it("excludes archived accounts and other users", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(u.id, { openingBalance: m(1000) });
    const archived = seedAccount(u.id, {
      name: "Old",
      openingBalance: m(99999),
    });
    seedImportedTransaction(u.id, archived.id, { amount: m(5) });
    const { archiveAccount } = await import("$lib/server/ledger");
    archiveAccount(u.id, archived.id);
    const foreign = seedAccount(other.id, { openingBalance: m(777777) });
    seedImportedTransaction(other.id, foreign.id, {
      bookingDate: "2026-09-01",
      amount: m(1),
    });
    expect(a.id).not.toBe(archived.id);

    const series = netWorthSeries(u.id, { today: TODAY });
    expect(series).toHaveLength(1);
    expect(series[0]!.points.at(-1)!.amount).toBe(1000);
    expect(
      netWorthSeries(other.id, { today: TODAY })[0]!.points.at(-1)!.amount,
    ).toBe(777778);
  });

  it("supports weekly and daily steps and explicit ranges", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, {
      openingBalance: m(0),
      openingDate: "2026-09-01",
    });
    seedImportedTransaction(u.id, a.id, {
      bookingDate: "2026-10-08",
      amount: m(100),
    });
    const week = netWorthSeries(u.id, {
      from: "2026-10-01",
      to: TODAY,
      step: "week",
      today: TODAY,
    })[0]!;
    expect(week.points.map((p) => [p.date, p.amount])).toEqual([
      ["2026-10-01", 0],
      ["2026-10-08", 100],
      ["2026-10-15", 100],
    ]);
    const day = netWorthSeries(u.id, {
      from: "2026-10-14",
      to: TODAY,
      step: "day",
      today: TODAY,
    })[0]!;
    expect(day.points).toHaveLength(2);
  });

  it("returns an empty list without accounts and finds the earliest date", async () => {
    const u = await createTestUser();
    expect(netWorthSeries(u.id, { today: TODAY })).toEqual([]);
    expect(earliestDataDate(u.id)).toBeNull();
    const a = seedAccount(u.id, { openingDate: "2025-05-01" });
    seedImportedTransaction(u.id, a.id, { bookingDate: "2025-03-15" });
    expect(earliestDataDate(u.id)).toBe("2025-03-15");
  });
});

describe("accountBalances", () => {
  useTestDB();

  it("reports balances, institution, masked IBAN and staleness", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const fresh = seedAccount(u.id, {
      name: "Fresh",
      iban: EXAMPLE_IBAN,
      openingBalance: m(1000),
    });
    seedImport(u.id, fresh.id, { createdAt: new Date("2026-10-10T12:00:00") });
    seedImportedTransaction(u.id, fresh.id, {
      bookingDate: "2026-10-09",
      amount: m(-200),
    });
    const old = seedAccount(u.id, { name: "Old import" });
    seedImport(u.id, old.id, { createdAt: new Date("2026-08-01T12:00:00") });
    const boundary = seedAccount(u.id, { name: "Boundary" });
    seedImport(u.id, boundary.id, {
      createdAt: new Date("2026-08-31T12:00:00"),
    });
    const pensionNew = seedAccount(u.id, { name: "P new", type: "pension" });
    createSnapshot(u.id, pensionNew.id, {
      date: "2026-07-01",
      amount: m(10),
    } as never);
    const pensionOld = seedAccount(u.id, { name: "P old", type: "pension" });
    createSnapshot(u.id, pensionOld.id, {
      date: "2026-05-01",
      amount: m(10),
    } as never);
    const future = seedAccount(u.id, { name: "Future snap", type: "pension" });
    createSnapshot(u.id, future.id, {
      date: "2026-12-01",
      amount: m(10),
    } as never);
    const empty = seedAccount(u.id, { name: "Empty" });
    seedAccount(other.id, { name: "Foreign" });

    const list = accountBalances(u.id, TODAY);
    const by = Object.fromEntries(list.map((a) => [a.name, a]));
    expect(Object.keys(by).sort()).toEqual([
      "Boundary",
      "Empty",
      "Fresh",
      "Future snap",
      "Old import",
      "P new",
      "P old",
    ]);
    expect(by.Fresh).toMatchObject({
      balance: 800,
      lastBookingDate: "2026-10-09",
      stale: false,
      staleDays: 5,
    });
    expect(by.Fresh!.ibanMasked).toContain("•");
    expect(by.Fresh!.ibanMasked).not.toContain("62011623");
    expect(by["Old import"]).toMatchObject({ stale: true, staleDays: 75 });
    // exactly 45 days is not yet stale
    expect(by.Boundary).toMatchObject({ stale: false, staleDays: 45 });
    expect(by["P new"]).toMatchObject({
      stale: false,
      staleDays: 106,
      lastSnapshotDate: "2026-07-01",
      lastImportAt: null,
    });
    expect(by["P old"]).toMatchObject({ stale: true, staleDays: 167 });
    expect(by["Future snap"]).toMatchObject({
      lastSnapshotDate: null,
      staleDays: null,
    });
    expect(by.Empty).toMatchObject({
      stale: false,
      staleDays: null,
      noData: true,
    });
    expect(by.Fresh!.noData).toBe(false);
    expect(by["P new"]!.noData).toBe(false);
    expect(empty.id).toBe(by.Empty!.id);

    const imports = lastImports(u.id, TODAY);
    expect(imports.find((i) => i.accountName === "P old")!.stale).toBe(true);
  });

  it("omits archived accounts", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id);
    const { archiveAccount } = await import("$lib/server/ledger");
    archiveAccount(u.id, a.id);
    expect(accountBalances(u.id, TODAY)).toEqual([]);
  });
});

describe("monthSummary", () => {
  useTestDB();

  it("buckets by the account currency and keeps other users' IBANs out of the transfer rule", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(u.id, { iban: EXAMPLE_IBAN });
    seedAccount(other.id, { iban: EXAMPLE_IBAN_OTHER });
    seedImportedTransaction(u.id, a.id, {
      bookingDate: "2026-10-03",
      amount: m(-400),
      currency: "EUR",
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    const s = monthSummary(u.id, { month: "2026-10" });
    expect(s.totals).toEqual([
      { currency: "CHF", income: 0, expenses: 400, net: -400 },
    ]);
  });

  it("splits income and expenses per currency at month boundaries", async () => {
    const u = await createTestUser();
    const chf = seedAccount(u.id);
    const eur = seedAccount(u.id, { name: "Eur", currency: "EUR" });
    const tx = (
      accountId: string,
      bookingDate: string,
      amount: number,
      currency = "CHF",
    ) =>
      seedImportedTransaction(u.id, accountId, {
        bookingDate,
        amount: m(amount),
        currency,
      });
    tx(chf.id, "2026-09-30", 100000);
    tx(chf.id, "2026-09-30", -4000);
    tx(chf.id, "2026-10-01", 50000);
    tx(chf.id, "2026-10-31", -1234);
    tx(chf.id, "2026-10-15", -766);
    tx(chf.id, "2026-11-01", -99999);
    tx(chf.id, "2026-08-31", -99999);
    tx(eur.id, "2026-10-05", -300, "EUR");

    const s = monthSummary(u.id, { month: "2026-10" });
    expect(s.previousMonth).toBe("2026-09");
    expect(s.totals).toEqual([
      { currency: "CHF", income: 50000, expenses: 2000, net: 48000 },
      { currency: "EUR", income: 0, expenses: 300, net: -300 },
    ]);
    expect(s.previousTotals).toEqual([
      { currency: "CHF", income: 100000, expenses: 4000, net: 96000 },
      { currency: "EUR", income: 0, expenses: 0, net: 0 },
    ]);
  });

  it("wraps across years and handles February", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id);
    seedImportedTransaction(u.id, a.id, {
      bookingDate: "2025-12-31",
      amount: m(-10),
    });
    seedImportedTransaction(u.id, a.id, {
      bookingDate: "2026-02-28",
      amount: m(-20),
    });
    const jan = monthSummary(u.id, { month: "2026-01" });
    expect(jan.previousMonth).toBe("2025-12");
    expect(jan.previousTotals[0]!.expenses).toBe(10);
    expect(monthSummary(u.id, { month: "2026-02" }).totals[0]!.expenses).toBe(
      20,
    );
  });

  it("excludes transfers between own accounts", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, { name: "A", iban: EXAMPLE_IBAN });
    const b = seedAccount(u.id, { name: "B", iban: EXAMPLE_IBAN_OTHER });
    const c = seedAccount(u.id, { name: "C", iban: null });
    const base = { bookingDate: "2026-10-03" };
    seedImportedTransaction(u.id, a.id, {
      ...base,
      amount: m(-5000),
      counterpartyIban: " ch44 3199 9123 0008 8901 2 ",
    });
    seedImportedTransaction(u.id, b.id, {
      ...base,
      amount: m(5000),
      counterpartyIban: EXAMPLE_IBAN,
    });
    // external counterparty still counts
    seedImportedTransaction(u.id, c.id, {
      ...base,
      amount: m(-70),
      counterpartyIban: FOREIGN_IBANS[0],
    });
    const s = monthSummary(u.id, { month: "2026-10" });
    expect(s.totals).toEqual([
      { currency: "CHF", income: 0, expenses: 70, net: -70 },
    ]);
  });

  it("ignores archived accounts and other users", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(u.id);
    const old = seedAccount(u.id, { name: "Old" });
    const foreign = seedAccount(other.id);
    const { archiveAccount } = await import("$lib/server/ledger");
    seedImportedTransaction(u.id, a.id, {
      bookingDate: "2026-10-03",
      amount: m(-100),
    });
    seedImportedTransaction(u.id, old.id, {
      bookingDate: "2026-10-03",
      amount: m(-900),
    });
    archiveAccount(u.id, old.id);
    seedImportedTransaction(other.id, foreign.id, {
      bookingDate: "2026-10-03",
      amount: m(-5000),
    });
    const s = monthSummary(u.id, { month: "2026-10" });
    expect(s.totals).toEqual([
      { currency: "CHF", income: 0, expenses: 100, net: -100 },
    ]);
    expect(monthSummary(u.id, { month: "2024-01" }).totals).toEqual([]);
  });
});

describe("billsSummary and unmatchedTransactions", () => {
  useTestDB();

  it("groups bills with totals per currency and lists upcoming ones", async () => {
    const u = await createTestUser();
    seedBill(u.id, { dueDate: addDays(TODAY, -3), amount: m(10000) });
    seedBill(u.id, { dueDate: addDays(TODAY, -1), amount: m(2500) });
    seedBill(u.id, {
      dueDate: addDays(TODAY, -1),
      amount: m(700),
      currency: "EUR",
    });
    seedBill(u.id, { dueDate: addDays(TODAY, 5), amount: m(3000) });
    seedBill(u.id, { dueDate: addDays(TODAY, 14), amount: m(1000) });
    seedBill(u.id, { dueDate: addDays(TODAY, 15), amount: m(4000) });
    seedBill(u.id, { dueDate: addDays(TODAY, 40), amount: m(5000) });
    seedBill(u.id, { dueDate: addDays(TODAY, 50), amount: m(6000) });
    seedBill(u.id, { dueDate: null, amount: null });
    seedBill(u.id, { kind: "credit_note", amount: m(1500), dueDate: null });
    seedBill(u.id, { dueDate: addDays(TODAY, 1), amount: m(1) });
    const s = billsSummary(u.id, TODAY);
    expect(s.overdue.count).toBe(3);
    expect(s.overdue.totals).toEqual([
      { currency: "CHF", amount: 12500 },
      { currency: "EUR", amount: 700 },
    ]);
    expect(s.dueSoon.count).toBe(3);
    expect(s.dueSoon.totals).toEqual([{ currency: "CHF", amount: 4001 }]);
    expect(s.awaitingRefund).toMatchObject({
      count: 1,
      totals: [{ currency: "CHF", amount: 1500 }],
    });
    expect(s.upcoming).toHaveLength(5);
    expect(s.upcoming.map((b) => b.dueDate)).toEqual([
      addDays(TODAY, 1),
      addDays(TODAY, 5),
      addDays(TODAY, 14),
      addDays(TODAY, 15),
      addDays(TODAY, 40),
    ]);
    expect(overdueBillCount(u.id, TODAY)).toBe(3);
  });

  it("counts overpaid invoices as refunds and open-amount bills without a total", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id);
    const bill = seedBill(u.id, {
      amount: m(1000),
      dueDate: addDays(TODAY, 3),
    });
    const tx = seedImportedTransaction(u.id, a.id, {
      bookingDate: addDays(TODAY, -1),
      amount: m(-1300),
    });
    allocate(u.id, bill.id, tx.id, m(1300), "user");
    seedBill(u.id, { amount: null, dueDate: addDays(TODAY, -2) });
    const s = billsSummary(u.id, TODAY);
    expect(s.awaitingRefund.totals).toEqual([{ currency: "CHF", amount: 300 }]);
    expect(s.overdue).toMatchObject({ count: 1, openAmountCount: 1 });
    expect(s.overdue.totals).toEqual([{ currency: "CHF", amount: 0 }]);
  });

  it("counts read-only suggestions without matching anything", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id);
    seedBill(u.id, {
      amount: m(10000),
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      dueDate: addDays(TODAY, 2),
      issueDate: addDays(TODAY, -20),
    });
    seedImportedTransaction(u.id, a.id, {
      bookingDate: addDays(TODAY, -1),
      amount: m(-10000),
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    expect(billsSummary(u.id, TODAY).unmatchedSuggestions).toBe(1);
    expect(unmatchedTransactions(u.id, { today: TODAY }).count).toBe(1);
    // nothing was allocated by reading the summary
    expect(billsSummary(u.id, TODAY).unmatchedSuggestions).toBe(1);
  });

  it("finds outgoing referenced payments without allocation", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(u.id);
    const foreign = seedAccount(other.id);
    const ref = { referenceType: "SCOR" as const, reference: EXAMPLE_SCOR };
    const hit = (date: string, amount = -500, over = {}) =>
      seedImportedTransaction(u.id, a.id, {
        bookingDate: date,
        amount: m(amount),
        ...ref,
        ...over,
      });
    hit(addDays(TODAY, -1));
    hit(addDays(TODAY, -60));
    hit(addDays(TODAY, -61));
    hit(addDays(TODAY, 1));
    hit(addDays(TODAY, -2), 500);
    hit(addDays(TODAY, -2), -500, { referenceType: null, reference: null });
    const allocated = hit(addDays(TODAY, -3));
    const bill = seedBill(u.id, { amount: m(500) });
    allocate(u.id, bill.id, allocated.id, m(500), "user");
    seedImportedTransaction(other.id, foreign.id, {
      bookingDate: addDays(TODAY, -1),
      amount: m(-500),
      ...ref,
    });
    expect(unmatchedTransactions(u.id, { today: TODAY })).toEqual({
      days: 60,
      count: 2,
    });
    expect(unmatchedTransactions(u.id, { days: 10, today: TODAY }).count).toBe(
      1,
    );
  });
});

describe("dashboard", () => {
  useTestDB();

  it("assembles everything and scopes it to the user", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(u.id, {
      openingBalance: m(5000),
      openingDate: "2026-01-01",
    });
    seedImportedTransaction(u.id, a.id, {
      bookingDate: "2026-10-02",
      amount: m(-1000),
    });
    const foreign = seedAccount(other.id, { openingBalance: m(123456) });
    seedBill(other.id, { dueDate: addDays(TODAY, -5) });
    seedImportedTransaction(other.id, foreign.id, {
      bookingDate: "2026-10-02",
    });

    const d = dashboard(u.id, TODAY);
    expect(d.range).toBe("12m");
    expect(d.netWorth.totals).toEqual([
      { currency: "CHF", balance: 4000, shareBalance: 4000, accountCount: 1 },
    ]);
    expect(d.netWorth.series[0]!.points.at(-1)!.amount).toBe(4000);
    expect(d.accounts).toHaveLength(1);
    expect(d.month.totals[0]!.expenses).toBe(1000);
    expect(d.bills.overdue.count).toBe(0);
    expect(d.overdueBills).toBe(0);
    expect(d.imports).toHaveLength(1);
    expect(d.staleAccounts).toBe(0);

    const all = dashboard(u.id, TODAY, { range: "all" });
    expect(all.range).toBe("all");
    expect(all.netWorth.from).toBe("2026-01-01");
    expect(dashboard(u.id, TODAY, { range: "3m" }).netWorth.step).toBe("week");
    expect(dashboard(other.id, TODAY).overdueBills).toBe(1);
  });

  it("works for a user without data", async () => {
    const u = await createTestUser();
    const d = dashboard(u.id, TODAY, { range: "all" });
    expect(d.netWorth.series).toEqual([]);
    expect(d.accounts).toEqual([]);
    expect(d.month.totals).toEqual([]);
    expect(d.unmatched.count).toBe(0);
  });
});
