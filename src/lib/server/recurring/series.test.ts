import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  confirmSeries,
  dismissSeries,
  editSeries,
  listRecurring,
  projectRecurring,
  recurringTotals,
  restoreSeries,
  syncRecurring,
} from "./series";

useTestDB();

async function setup() {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const eur = await seedAccount(user.id, { name: "Euro", currency: "EUR" });
  const pay = async (
    bookingDate: string,
    amount: number,
    counterpartyName: string,
    over: { currency?: string; reversal?: boolean } = {},
  ) =>
    await seedImportedTransaction(
      user.id,
      over.currency === "EUR" ? eur.id : account.id,
      {
        bookingDate,
        amount: minor(amount),
        currency: over.currency ?? "CHF",
        counterpartyName,
        reversal: over.reversal ?? false,
      },
    );
  const months = async (
    name: string,
    amounts: number[],
    day = "05",
    over: { currency?: string } = {},
  ) => {
    for (const [i, a] of amounts.entries()) {
      await pay(`2026-${String(i + 1).padStart(2, "0")}-${day}`, a, name, over);
    }
  };
  return { user, pay, months };
}

describe("syncRecurring", () => {
  it("stores detected series as suggestions", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    syncRecurring(user.id);
    const list = listRecurring(user.id, "2026-04-01");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: "suggested",
      name: "Example Streaming",
      cadence: "monthly",
      amount: -1290,
      annualCost: -15480,
      monthlyCost: -1290,
      lastDate: "2026-03-05",
      nextExpected: "2026-04-05",
      overdue: false,
      priceChange: null,
    });
  });

  it("is idempotent", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    syncRecurring(user.id);
    syncRecurring(user.id);
    expect(listRecurring(user.id)).toHaveLength(1);
  });

  it("flags a price change and an overdue payment", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290, -1490]);
    syncRecurring(user.id);
    const [s] = listRecurring(user.id, "2026-05-20");
    expect(s?.priceChange).toEqual({
      previous: -1290,
      latest: -1490,
      delta: -200,
    });
    expect(s?.amount).toBe(-1490);
    expect(s?.overdue).toBe(true);
  });

  it("keeps a dismissal when detection runs again", async () => {
    const { user, months, pay } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    syncRecurring(user.id);
    const [s] = listRecurring(user.id);
    dismissSeries(user.id, s!.id);
    await pay("2026-04-05", -1290, "Example Streaming");
    syncRecurring(user.id);
    const after = listRecurring(user.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      status: "dismissed",
      lastDate: "2026-04-05",
    });
    restoreSeries(user.id, s!.id);
    expect(listRecurring(user.id)[0]?.status).toBe("suggested");
  });

  it("keeps edits and refreshes statistics around them", async () => {
    const { user, months, pay } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    syncRecurring(user.id);
    const [s] = listRecurring(user.id);
    confirmSeries(user.id, s!.id);
    editSeries(user.id, s!.id, {
      name: "Streaming",
      cadence: "monthly",
      amount: "13.00",
    });
    await pay("2026-04-05", -1490, "Example Streaming");
    syncRecurring(user.id);
    expect(listRecurring(user.id)[0]).toMatchObject({
      status: "confirmed",
      name: "Streaming",
      amount: -1300,
      lastAmount: -1490,
      lastDate: "2026-04-05",
    });
  });

  it("drops suggestions that no longer hold but keeps confirmed series", async () => {
    const { user, months } = await setup();
    await months("Gym", [-5000, -5000, -5000]);
    await months("Insurance", [-9000, -9000, -9000], "10");
    syncRecurring(user.id);
    const insurance = listRecurring(user.id).find(
      (s) => s.name === "Insurance",
    )!;
    confirmSeries(user.id, insurance.id);
    // Re-importing never removes rows here, so simulate by wiping the user's transactions.
    const { getDB, transactions } = await import("$lib/server/db");
    getDB().delete(transactions).run();
    syncRecurring(user.id);
    expect(listRecurring(user.id).map((s) => s.name)).toEqual(["Insurance"]);
  });

  it("ignores refunded charges", async () => {
    const { user, pay } = await setup();
    await pay("2026-01-05", -1290, "Example Streaming");
    await pay("2026-02-05", -1290, "Example Streaming");
    await pay("2026-02-10", 1290, "Example Streaming");
    await pay("2026-03-05", -1290, "Example Streaming");
    await pay("2026-04-05", -1290, "Example Streaming");
    syncRecurring(user.id);
    expect(listRecurring(user.id)[0]?.occurrences).toBe(3);
  });

  it("never touches another user's data", async () => {
    const a = await setup();
    const b = await setup();
    await a.months("Example Streaming", [-1290, -1290, -1290]);
    syncRecurring(b.user.id);
    expect(listRecurring(b.user.id)).toEqual([]);
    syncRecurring(a.user.id);
    const [s] = listRecurring(a.user.id);
    expect(() => confirmSeries(b.user.id, s!.id)).toThrow("not found");
    expect(() => dismissSeries(b.user.id, s!.id)).toThrow("not found");
    expect(() =>
      editSeries(b.user.id, s!.id, {
        name: "x",
        cadence: "weekly",
        amount: "1",
      }),
    ).toThrow("not found");
    expect(projectRecurring(b.user.id, "2026-01-01", "2026-12-31")).toEqual([]);
  });
});

describe("editSeries", () => {
  it("keeps the direction and rejects bad amounts", async () => {
    const { user, months } = await setup();
    await months("Employer", [500000, 500000, 500000], "25");
    syncRecurring(user.id);
    const [s] = listRecurring(user.id);
    editSeries(user.id, s!.id, {
      name: "Employer",
      cadence: "monthly",
      amount: "5'100.00",
    });
    expect(listRecurring(user.id)[0]?.amount).toBe(510000);
    expect(() =>
      editSeries(user.id, s!.id, {
        name: "Employer",
        cadence: "monthly",
        amount: "abc",
      }),
    ).toThrow();
    expect(() =>
      editSeries(user.id, s!.id, {
        name: "Employer",
        cadence: "monthly",
        amount: "0",
      }),
    ).toThrow("zero");
  });
});

describe("recurringTotals", () => {
  it("sums confirmed series per currency without converting", async () => {
    const { user, months } = await setup();
    await months("Streaming", [-1000, -1000, -1000]);
    await months("Cloud", [-200, -200, -200], "07", { currency: "EUR" });
    await months("Employer", [400000, 400000, 400000], "25");
    await months("Pending", [-777, -777, -777], "12");
    syncRecurring(user.id);
    for (const s of listRecurring(user.id)) {
      if (s.name !== "Pending") confirmSeries(user.id, s.id);
    }
    expect(recurringTotals(listRecurring(user.id))).toEqual([
      {
        currency: "CHF",
        outflowMonthly: 1000,
        outflowAnnual: 12000,
        inflowMonthly: 400000,
        inflowAnnual: 4800000,
      },
      {
        currency: "EUR",
        outflowMonthly: 200,
        outflowAnnual: 2400,
        inflowMonthly: 0,
        inflowAnnual: 0,
      },
    ]);
  });
});

describe("projectRecurring", () => {
  it("projects confirmed series after their last payment, sorted by date", async () => {
    const { user, months, pay } = await setup();
    await months("Streaming", [-1000, -1000, -1000]);
    await months("Rent", [-150000, -150000, -150000], "01");
    await pay("2026-01-15", -8000, "Insurer");
    await pay("2026-04-15", -8000, "Insurer");
    await pay("2026-07-15", -8000, "Insurer");
    syncRecurring(user.id);
    for (const s of listRecurring(user.id)) confirmSeries(user.id, s.id);

    const out = projectRecurring(user.id, "2026-04-01", "2026-05-31");
    expect(
      out.map((o) => [o.date, o.name, o.amount, o.currency, o.cadence]),
    ).toEqual([
      ["2026-04-01", "Rent", -150000, "CHF", "monthly"],
      ["2026-04-05", "Streaming", -1000, "CHF", "monthly"],
      ["2026-05-01", "Rent", -150000, "CHF", "monthly"],
      ["2026-05-05", "Streaming", -1000, "CHF", "monthly"],
    ]);
    const wide = projectRecurring(user.id, "2026-08-01", "2026-12-31");
    expect(wide.filter((o) => o.name === "Insurer").map((o) => o.date)).toEqual(
      ["2026-10-15"],
    );
  });

  it("skips suggested and dismissed series and includes both bounds", async () => {
    const { user, months } = await setup();
    await months("Streaming", [-1000, -1000, -1000]);
    await months("Gym", [-5000, -5000, -5000], "10");
    await months("Cloud", [-200, -200, -200], "07");
    syncRecurring(user.id);
    for (const s of listRecurring(user.id)) {
      if (s.name === "Streaming") confirmSeries(user.id, s.id);
      if (s.name === "Gym") dismissSeries(user.id, s.id);
    }
    const out = projectRecurring(user.id, "2026-04-05", "2026-04-05");
    expect(out.map((o) => o.name)).toEqual(["Streaming"]);
  });

  it("projects income as positive and keeps currencies apart", async () => {
    const { user, months } = await setup();
    await months("Employer", [400000, 400000, 400000], "25");
    await months("Cloud", [-200, -200, -200], "07", { currency: "EUR" });
    syncRecurring(user.id);
    for (const s of listRecurring(user.id)) confirmSeries(user.id, s.id);
    const out = projectRecurring(user.id, "2026-04-01", "2026-04-30");
    expect(out.map((o) => [o.name, o.amount, o.currency])).toEqual([
      ["Cloud", -200, "EUR"],
      ["Employer", 400000, "CHF"],
    ]);
  });

  it("starts from the latest amount after a price change", async () => {
    const { user, months } = await setup();
    await months("Streaming", [-1000, -1000, -1000, -1200]);
    syncRecurring(user.id);
    confirmSeries(user.id, listRecurring(user.id)[0]!.id);
    const [o] = projectRecurring(user.id, "2026-05-01", "2026-05-31");
    expect(o?.amount).toBe(-1200);
  });

  it("returns nothing for an empty or inverted range and rejects bad dates", async () => {
    const { user } = await setup();
    expect(projectRecurring(user.id, "2026-05-01", "2026-04-01")).toEqual([]);
    expect(() =>
      projectRecurring(user.id, "2026-13-01", "2026-14-01"),
    ).toThrow();
  });
});
