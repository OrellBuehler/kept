import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  assignCategory,
  createCategory,
} from "$lib/server/categories/categories";
import {
  createManualTransaction,
  deleteTransaction,
} from "$lib/server/ledger/transactions";
import { setTransactionDeductionExcluded } from "$lib/server/tax/deductions";
import { listChanges } from "./list";
import { transactionSummary } from "./snapshots";

useTestDB();

const newest = async (userId: string) =>
  (await listChanges(userId, { limit: 1 })).items[0]!;

const manual = (over: Record<string, unknown> = {}) => ({
  bookingDate: "2026-09-01",
  valueDate: null,
  amount: minor(-500),
  counterpartyName: null,
  counterpartyIban: null,
  description: "Invoice 12 for CHF 500.00, pay to the IBAN on file",
  reference: null,
  note: null,
  ...over,
});

describe("transactionSummary", () => {
  it("is the counterparty when there is one, cut at 80 characters", () => {
    expect(
      transactionSummary({
        counterpartyName: "Example Grocer",
        bookingDate: "2026-09-01",
      }),
    ).toBe("Example Grocer");
    const long = transactionSummary({
      counterpartyName: "x".repeat(200),
      bookingDate: "2026-09-01",
    });
    expect(long).toHaveLength(80);
  });

  it("is the booking date when there is no counterparty, never the description", () => {
    for (const counterpartyName of [null, "", "  "]) {
      expect(
        transactionSummary({ counterpartyName, bookingDate: "2026-09-01" }),
      ).toBe("Payment of 2026-09-01");
    }
  });
});

describe("transaction entries", () => {
  it("never put the description or an amount in the summary", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const food = await createCategory(u.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    const created = await createManualTransaction(u.id, account.id, manual());
    expect((await newest(u.id)).summary).toBe("Payment of 2026-09-01");
    await assignCategory(u.id, created.id, food.id);
    expect((await newest(u.id)).summary).toBe("Payment of 2026-09-01");
    await setTransactionDeductionExcluded(u.id, created.id, true);
    const entry = await newest(u.id);
    expect(entry.action).toBe("transaction.update");
    expect(entry.summary).toBe("Payment of 2026-09-01");
    const imported = await seedImportedTransaction(u.id, account.id, {
      counterpartyName: null,
      description: "Standing order 500.00",
    });
    await assignCategory(u.id, imported.id, food.id);
    expect((await newest(u.id)).summary).not.toMatch(/500|Standing/);
  });

  it("keep timestamps of a deleted payment as epoch milliseconds like every other snapshot", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const created = await createManualTransaction(u.id, account.id, manual());
    await deleteTransaction(u.id, created.id);
    const entry = await newest(u.id);
    expect(entry.action).toBe("transaction.delete");
    expect(typeof entry.before!.createdAt).toBe("number");
  });
});
