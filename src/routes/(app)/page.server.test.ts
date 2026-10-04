import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { addDays, type Dashboard } from "$lib/server/dashboard";
import { localToday } from "$lib/server/ledger/balances";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { linkTransfers } from "$lib/server/transfers/link";
import { load as loadLayout } from "./+layout.server";
import { load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
interface PageData {
  today: string;
  dashboard: Dashboard;
  needsAmount: { sourceAccountName: string; targetAccountName: string }[];
}
const loadAs = async (user: User, url?: string) => {
  const r = await outcome(() => load(createTestEvent({ user, url }) as never));
  if (r.type !== "return") throw new Error("load failed");
  return r.value as PageData;
};

describe("dashboard page", () => {
  useTestDB();

  it("returns the dashboard for the current user only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const today = localToday();
    const a = seedAccount(u.id, { openingBalance: minor(1000) });
    seedImportedTransaction(u.id, a.id, {
      bookingDate: today,
      amount: minor(-100),
    });
    seedAccount(other.id, { name: "Other", openingBalance: minor(99999) });
    seedBill(other.id, { dueDate: addDays(today, -2) });

    const data = await loadAs(u);
    expect(data.today).toBe(today);
    expect(data.dashboard.range).toBe("12m");
    expect(data.dashboard.accounts).toHaveLength(1);
    expect(data.dashboard.netWorth.totals[0]!.balance).toBe(900);
    expect(data.dashboard.bills.overdue.count).toBe(0);
    expect(data.dashboard.netWorth.series[0]!.points.at(-1)!.date).toBe(today);
  });

  it("returns liquidity for the current user only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    seedAccount(u.id, { openingBalance: minor(1000) });
    seedAccount(u.id, {
      name: "Notice",
      type: "savings",
      openingBalance: minor(50000),
      noticeMonths: 6,
      freeWithdrawal: minor(10000),
      freeWithdrawalPeriod: "year",
    });
    seedAccount(other.id, {
      name: "Other",
      type: "savings",
      openingBalance: minor(99999),
      noticeMonths: 3,
    });

    const { dashboard } = await loadAs(u);
    const chf = dashboard.liquidity.find((l) => l.currency === "CHF")!;
    expect(chf.now.balance).toBe(11000);
    expect(chf.ladder).toHaveLength(1);
    expect(chf.ladder[0]).toMatchObject({ months: 6, balance: 40000 });
    expect(dashboard.invested).toEqual([]);
  });

  it("lists foreign-currency transfers that wait for an amount, for the current user only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(u.id, { name: "Main", iban: EXAMPLE_IBAN });
    seedAccount(u.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    seedImportedTransaction(u.id, a.id, {
      amount: minor(-100),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(u.id, {});
    expect((await loadAs(u)).needsAmount).toEqual([
      expect.objectContaining({
        sourceAccountName: "Main",
        targetAccountName: "Euro",
      }),
    ]);
    expect((await loadAs(other)).needsAmount).toEqual([]);
  });

  it("honours the range parameter and falls back to 12m", async () => {
    const u = await createTestUser();
    seedAccount(u.id);
    const range = async (query: string) =>
      (await loadAs(u, `http://localhost/${query}`)).dashboard;
    expect((await range("?range=3m")).range).toBe("3m");
    const all = await range("?range=all");
    expect(all.range).toBe("all");
    expect(all.netWorth.step).toBe("month");
    expect((await range("?range=zzz")).range).toBe("12m");
  });
});

describe("app layout", () => {
  useTestDB();

  it("returns the user and their overdue bill count", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const today = localToday();
    seedBill(u.id, { dueDate: addDays(today, -1) });
    seedBill(u.id, { dueDate: addDays(today, 3) });
    seedBill(other.id, { dueDate: addDays(today, -4) });
    seedBill(other.id, { dueDate: addDays(today, -5) });
    const data = (await loadLayout(createTestEvent({ user: u }) as never)) as {
      user: { id: string };
      overdueBills: number;
    };
    expect(data.user.id).toBe(u.id);
    expect(data.overdueBills).toBe(1);
  });
});
