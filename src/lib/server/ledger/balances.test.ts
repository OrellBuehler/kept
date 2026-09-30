import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  accountBalanceAt,
  balanceAt,
  balanceSeries,
  balanceSeriesOf,
  currentBalance,
  seriesDates,
  type BalanceInput,
} from "./balances";
import { createSnapshot } from "./snapshots";
import { createManualTransaction } from "./transactions";
import { LedgerError } from "./errors";

const tx = (bookingDate: string, amount: number) => ({ bookingDate, amount });
const base: BalanceInput = {
  openingBalance: 0,
  openingDate: null,
  snapshots: [],
  transactions: [],
};

describe("balanceAt (pure)", () => {
  it("is the opening balance for an empty account", () => {
    expect(balanceAt({ ...base, openingBalance: 500 }, "2024-05-01")).toBe(500);
  });

  it("transaction-only accounts sum transactions up to and including the date", () => {
    const input = {
      ...base,
      openingBalance: 1000,
      transactions: [
        tx("2024-01-10", -100),
        tx("2024-01-11", 50),
        tx("2024-01-12", 7),
      ],
    };
    expect(balanceAt(input, "2024-01-09")).toBe(1000);
    expect(balanceAt(input, "2024-01-10")).toBe(900);
    expect(balanceAt(input, "2024-01-11")).toBe(950);
    expect(balanceAt(input, "2030-01-01")).toBe(957);
  });

  it("ignores transactions before the opening date and treats opening as start of day", () => {
    const input: BalanceInput = {
      ...base,
      openingBalance: 1000,
      openingDate: "2024-02-01",
      transactions: [
        tx("2024-01-20", -999),
        tx("2024-02-01", -100),
        tx("2024-02-02", 10),
      ],
    };
    expect(balanceAt(input, "2024-01-25")).toBe(1000);
    expect(balanceAt(input, "2024-02-01")).toBe(900);
    expect(balanceAt(input, "2024-02-02")).toBe(910);
  });

  it("snapshot-only accounts (pension) step at each snapshot", () => {
    const input: BalanceInput = {
      ...base,
      snapshots: [
        { date: "2024-12-31", amount: 20000 },
        { date: "2023-12-31", amount: 10000 },
      ],
    };
    expect(balanceAt(input, "2023-06-01")).toBe(0);
    expect(balanceAt(input, "2023-12-31")).toBe(10000);
    expect(balanceAt(input, "2024-06-30")).toBe(10000);
    expect(balanceAt(input, "2025-03-01")).toBe(20000);
  });

  it("snapshot is end-of-day: transactions on its date are not added again", () => {
    const input: BalanceInput = {
      ...base,
      openingBalance: 5,
      snapshots: [{ date: "2024-03-10", amount: 1000 }],
      transactions: [
        tx("2024-03-09", -1),
        tx("2024-03-10", -200),
        tx("2024-03-11", -30),
        tx("2024-03-12", 4),
      ],
    };
    expect(balanceAt(input, "2024-03-09")).toBe(5 - 1);
    expect(balanceAt(input, "2024-03-10")).toBe(1000);
    expect(balanceAt(input, "2024-03-11")).toBe(970);
    expect(balanceAt(input, "2024-03-12")).toBe(974);
  });

  it("uses the latest snapshot not after the date (snapshot in the middle)", () => {
    const input: BalanceInput = {
      ...base,
      openingBalance: 100,
      snapshots: [
        { date: "2024-01-31", amount: 500 },
        { date: "2024-03-31", amount: 900 },
      ],
      transactions: [
        tx("2024-01-15", 50),
        tx("2024-02-10", 10),
        tx("2024-03-01", 20),
        tx("2024-04-02", -5),
      ],
    };
    expect(balanceAt(input, "2024-01-20")).toBe(150);
    expect(balanceAt(input, "2024-02-28")).toBe(510);
    expect(balanceAt(input, "2024-03-31")).toBe(900);
    expect(balanceAt(input, "2024-04-30")).toBe(895);
  });

  it("prefers a manual snapshot over an imported one on the same date", () => {
    const input: BalanceInput = {
      ...base,
      snapshots: [
        { date: "2024-01-31", amount: 111, source: "import" },
        { date: "2024-01-31", amount: 222, source: "manual" },
        { date: "2024-02-29", amount: 333, source: "manual" },
        { date: "2024-02-29", amount: 444, source: "import" },
      ],
    };
    expect(balanceAt(input, "2024-01-31")).toBe(222);
    expect(balanceAt(input, "2024-02-29")).toBe(333);
  });

  it("handles negative balances (credit card) and does not depend on input order", () => {
    const input: BalanceInput = {
      ...base,
      transactions: [
        tx("2024-01-03", -30),
        tx("2024-01-01", -10),
        tx("2024-01-02", 5),
      ],
    };
    expect(balanceAt(input, "2024-01-02")).toBe(-5);
    expect(balanceAt(input, "2024-01-03")).toBe(-35);
  });
});

describe("seriesDates", () => {
  it("daily is inclusive", () => {
    expect(seriesDates("2024-02-27", "2024-03-01", "day")).toEqual([
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("monthly yields month ends with the last point clamped to `to`", () => {
    expect(seriesDates("2023-11-15", "2024-02-10", "month")).toEqual([
      "2023-11-30",
      "2023-12-31",
      "2024-01-31",
      "2024-02-10",
    ]);
    expect(seriesDates("2024-01-01", "2024-02-29", "month")).toEqual([
      "2024-01-31",
      "2024-02-29",
    ]);
    expect(seriesDates("2024-01-05", "2024-01-20", "month")).toEqual([
      "2024-01-20",
    ]);
  });

  it("returns nothing when from is after to and refuses absurd ranges", () => {
    expect(seriesDates("2024-02-01", "2024-01-01", "day")).toEqual([]);
    expect(() => seriesDates("1900-01-01", "2100-01-01", "day")).toThrow(
      LedgerError,
    );
  });
});

describe("balanceSeriesOf", () => {
  it("matches point-wise balanceAt", () => {
    const input: BalanceInput = {
      ...base,
      openingBalance: 10,
      snapshots: [{ date: "2024-01-05", amount: 100 }],
      transactions: [
        tx("2024-01-02", 1),
        tx("2024-01-06", -7),
        tx("2024-01-08", 3),
      ],
    };
    const series = balanceSeriesOf(input, "2024-01-01", "2024-01-09", "day");
    expect(series).toHaveLength(9);
    for (const p of series) expect(p.amount).toBe(balanceAt(input, p.date));
  });
});

describe("database balances", () => {
  useTestDB();

  it("combines opening balance, manual and imported transactions and snapshots", async () => {
    const user = await createTestUser();
    const account = seedAccount(user.id, {
      openingBalance: minor(1000),
      openingDate: "2024-01-01",
    });
    createManualTransaction(user.id, account.id, {
      bookingDate: "2024-01-05",
      valueDate: null,
      amount: minor(-250),
      counterpartyName: null,
      counterpartyIban: null,
      description: null,
      reference: null,
      note: null,
    });
    seedImportedTransaction(user.id, account.id, {
      bookingDate: "2024-01-10",
      amount: minor(400),
    });
    expect(accountBalanceAt(user.id, account.id, "2024-01-07")).toBe(750);
    expect(currentBalance(user.id, account.id)).toBe(1150);

    createSnapshot(user.id, account.id, {
      date: "2024-01-08",
      amount: minor(2000),
      note: null,
    });
    expect(accountBalanceAt(user.id, account.id, "2024-01-07")).toBe(750);
    expect(accountBalanceAt(user.id, account.id, "2024-01-08")).toBe(2000);
    expect(currentBalance(user.id, account.id)).toBe(2400);

    const series = balanceSeries(
      user.id,
      account.id,
      "2024-01-01",
      "2024-01-31",
      "month",
    );
    expect(series).toEqual([{ date: "2024-01-31", amount: 2400 }]);
  });

  it("does not see another user's account", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const account = seedAccount(a.id);
    expect(() => currentBalance(b.id, account.id)).toThrow(LedgerError);
    expect(() => accountBalanceAt(b.id, account.id, "2024-01-01")).toThrow(
      LedgerError,
    );
    expect(() =>
      balanceSeries(b.id, account.id, "2024-01-01", "2024-01-02", "day"),
    ).toThrow(LedgerError);
  });
});
