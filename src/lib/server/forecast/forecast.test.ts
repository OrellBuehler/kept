import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { allocateFromInput } from "$lib/server/bills/allocations";
import { addDays } from "$lib/server/dashboard/dates";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  createPlannedItem,
  deletePlannedItem,
  forecast,
  listPlannedItems,
  negativeBalanceAlerts,
  plannedItemInputSchema,
  saveAccountSettings,
  updatePlannedItem,
  type PlannedItemInput,
} from "./index";

useTestDB();

const TODAY = "2026-10-01";

const planned = (over: Record<string, string> = {}): PlannedItemInput =>
  plannedItemInputSchema.parse({
    label: "Salary",
    date: "2026-10-25",
    direction: "income",
    amount: "3000.00",
    accountId: "",
    currency: "CHF",
    ...over,
  });

describe("planned items", () => {
  it("creates, edits and deletes, scoped to the user", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = seedAccount(u.id);
    const created = createPlannedItem(
      u.id,
      planned({ accountId: acc.id, direction: "expense", amount: "120.50" }),
    );
    expect(created.amount).toBe(-12_050);
    expect(created.currency).toBe("CHF");

    const updated = updatePlannedItem(
      u.id,
      created.id,
      planned({ accountId: acc.id, amount: "10" }),
    );
    expect(updated.amount).toBe(1_000);

    expect(listPlannedItems(other.id)).toEqual([]);
    expect(() => updatePlannedItem(other.id, created.id, planned())).toThrow(
      LedgerError,
    );
    expect(() => deletePlannedItem(other.id, created.id)).toThrow(LedgerError);

    deletePlannedItem(u.id, created.id);
    expect(listPlannedItems(u.id)).toEqual([]);
  });

  it("takes the currency from the account and rejects foreign accounts", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const eur = seedAccount(u.id, { currency: "EUR" });
    const foreign = seedAccount(other.id);
    expect(
      createPlannedItem(u.id, planned({ accountId: eur.id, currency: "CHF" }))
        .currency,
    ).toBe("EUR");
    expect(() =>
      createPlannedItem(u.id, planned({ accountId: foreign.id })),
    ).toThrow(LedgerError);
  });

  it("rejects zero, malformed amounts and a missing currency", async () => {
    const u = await createTestUser();
    expect(() => createPlannedItem(u.id, planned({ amount: "0" }))).toThrow(
      LedgerError,
    );
    expect(() => createPlannedItem(u.id, planned({ amount: "abc" }))).toThrow(
      LedgerError,
    );
    expect(() => createPlannedItem(u.id, planned({ currency: "" }))).toThrow(
      LedgerError,
    );
    expect(
      plannedItemInputSchema.safeParse({
        label: "x",
        date: "2026-02-30",
        direction: "income",
        amount: "1",
      }).success,
    ).toBe(false);
  });
});

describe("account settings", () => {
  it("keeps one default payment account per currency", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, { name: "A" });
    const b = seedAccount(u.id, { name: "B" });
    saveAccountSettings(u.id, {
      accountId: a.id,
      threshold: "100",
      defaultPayment: "on",
    });
    saveAccountSettings(u.id, { accountId: b.id, defaultPayment: "on" });
    const f = forecast(u.id, TODAY, 30);
    expect(f.accounts).toHaveLength(2);
    seedBill(u.id, { dueDate: addDays(TODAY, 3) });
    const g = forecast(u.id, TODAY, 30);
    expect(g.accounts.find((x) => x.accountId === b.id)!.endBalance).toBe(
      -10_000,
    );
    expect(g.accounts.find((x) => x.accountId === a.id)!.threshold).toBe(
      10_000,
    );
  });

  it("does not touch another user's account", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const foreign = seedAccount(other.id);
    expect(() =>
      saveAccountSettings(u.id, { accountId: foreign.id, threshold: "1" }),
    ).toThrow(LedgerError);
  });
});

describe("forecast", () => {
  it("combines balance, open bills (net of partial payments) and planned items", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id, { openingBalance: minor(50_000) });
    const bill = seedBill(u.id, {
      amount: minor(30_000),
      dueDate: "2026-10-10",
      expectedAccountId: acc.id,
    });
    const tx = seedImportedTransaction(u.id, acc.id, {
      bookingDate: "2026-09-20",
      amount: minor(-10_000),
    });
    allocateFromInput(u.id, bill.id, tx.id, "100.00", "user");
    seedBill(u.id, {
      amount: minor(5_000),
      dueDate: "2026-09-15",
      expectedAccountId: acc.id,
    });
    createPlannedItem(
      u.id,
      planned({ accountId: acc.id, date: "2026-10-25", amount: "1000" }),
    );

    const f = forecast(u.id, TODAY, 30);
    const p = f.accounts[0]!;
    expect(p.startBalance).toBe(40_000);
    // overdue 50.00 on day 0, open 200.00 on the 10th, salary +1000.00 on the 25th
    expect(p.points[0]!.balance).toBe(35_000);
    expect(p.endBalance).toBe(35_000 - 20_000 + 100_000);
    expect(f.items.map((i) => i.source)).toEqual(["bill", "bill", "planned"]);
  });

  it("only reports negative balances as alerts", async () => {
    const u = await createTestUser();
    const low = seedAccount(u.id, {
      name: "Low",
      openingBalance: minor(2_000),
    });
    seedImportedTransaction(u.id, low.id, {
      bookingDate: "2026-09-20",
      amount: minor(-1_000),
    });
    const fine = seedAccount(u.id, {
      name: "Fine",
      openingBalance: minor(1_000_000),
    });
    seedImportedTransaction(u.id, fine.id, { bookingDate: "2026-09-20" });
    seedBill(u.id, {
      amount: minor(5_000),
      dueDate: "2026-10-08",
      expectedAccountId: low.id,
    });
    const alerts = negativeBalanceAlerts(u.id, TODAY);
    expect(alerts).toEqual([
      {
        accountId: low.id,
        name: "Low",
        currency: "CHF",
        date: "2026-10-08",
        balance: -4_000,
      },
    ]);
    expect(negativeBalanceAlerts(u.id, TODAY, 5)).toEqual([]);
  });

  it("never includes another user's data", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    seedAccount(u.id);
    const foreign = seedAccount(other.id);
    seedBill(other.id, {
      dueDate: "2026-10-05",
      expectedAccountId: foreign.id,
    });
    createPlannedItem(other.id, planned({ accountId: foreign.id }));
    const f = forecast(u.id, TODAY, 90);
    expect(f.items).toEqual([]);
    expect(f.accounts).toHaveLength(1);
  });
});
