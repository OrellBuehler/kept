import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { allocate } from "$lib/server/bills/allocations";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  addTaxCredit,
  deleteTaxCredit,
  deleteTaxYear,
  getTaxYear,
  listTaxYears,
  paymentLines,
  reconcileYear,
  setTransactionTaxYear,
  upsertTaxYear,
} from "./tax";
import { taxCreditInputSchema, taxYearInputSchema } from "./schemas";

const setup = async () => {
  const user = await createTestUser();
  const account = seedAccount(user.id);
  return { user, account };
};

const pay = (
  userId: string,
  accountId: string,
  cents: number,
  bookingDate: string,
  over = {},
) =>
  seedImportedTransaction(userId, accountId, {
    amount: minor(-cents),
    bookingDate,
    ...over,
  });

const yearInput = (over: Record<string, string> = {}) =>
  taxYearInputSchema.parse({
    year: "2025",
    authority: "Example Tax Office",
    currency: "CHF",
    assessedTotal: "",
    notes: "",
    ...over,
  });

const credit = (date: string, amount: string, reference = "") =>
  taxCreditInputSchema("CHF").parse({
    bookingDate: date,
    amount,
    reference,
    description: "",
  });

async function fails(fn: () => unknown): Promise<LedgerError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error("expected LedgerError");
}

describe("tax reconciliation", () => {
  useTestDB();

  it("reconciles partial payments and reports the amount still due", async () => {
    const { user, account } = await setup();
    for (const [cents, date] of [
      [100000, "2025-03-10"],
      [100000, "2025-06-10"],
    ] as const) {
      const tx = pay(user.id, account.id, cents, date);
      setTransactionTaxYear(user.id, tx.id, 2025);
    }
    upsertTaxYear(user.id, yearInput({ assessedTotal: "3000.00" }));
    addTaxCredit(user.id, 2025, credit("2025-03-12", "1000.00"));
    addTaxCredit(user.id, 2025, credit("2025-06-12", "1000.00"));

    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.counts).toEqual({
      matched: 2,
      amount_mismatch: 0,
      missing_office: 0,
      missing_mine: 0,
    });
    expect(rec.reconciled).toBe(true);
    expect(rec.balance).toMatchObject({
      paidByMe: 200000,
      creditedByOffice: 200000,
      assessedTotal: 300000,
      remaining: 100000,
      outcome: "due",
      amountDue: 100000,
    });
  });

  it("reports an overpayment as a refund to expect", async () => {
    const { user, account } = await setup();
    const tx = pay(user.id, account.id, 350000, "2025-03-10");
    setTransactionTaxYear(user.id, tx.id, 2025);
    upsertTaxYear(user.id, yearInput({ assessedTotal: "3000.00" }));
    addTaxCredit(user.id, 2025, credit("2025-03-11", "3500.00"));

    const { balance } = reconcileYear(user.id, 2025)!;
    expect(balance.outcome).toBe("refund");
    expect(balance.refundExpected).toBe(50000);
    expect(balance.amountDue).toBe(0);
  });

  it("highlights each kind of discrepancy", async () => {
    const { user, account } = await setup();
    for (const [cents, date] of [
      [100000, "2025-03-10"],
      [80000, "2025-06-10"],
      [50000, "2025-09-10"],
    ] as const) {
      setTransactionTaxYear(
        user.id,
        pay(user.id, account.id, cents, date).id,
        2025,
      );
    }
    upsertTaxYear(user.id, yearInput({ assessedTotal: "2300.00" }));
    addTaxCredit(user.id, 2025, credit("2025-03-11", "1000.00"));
    addTaxCredit(user.id, 2025, credit("2025-06-11", "750.00"));
    addTaxCredit(user.id, 2025, credit("2025-12-01", "200.00"));

    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.counts).toEqual({
      matched: 1,
      amount_mismatch: 1,
      missing_office: 1,
      missing_mine: 1,
    });
    expect(rec.reconciled).toBe(false);
    const mismatch = rec.rows.find((r) => r.kind === "amount_mismatch")!;
    expect(mismatch.difference).toBe(5000);
    expect(rec.rows.find((r) => r.kind === "missing_office")!.difference).toBe(
      50000,
    );
    expect(rec.rows.find((r) => r.kind === "missing_mine")!.difference).toBe(
      -20000,
    );
    expect(rec.balance.paidByMe).toBe(230000);
    expect(rec.balance.creditedByOffice).toBe(195000);
    expect(rec.balance.remaining).toBe(35000);
    expect(rec.balance.remainingByMe).toBe(0);
  });

  it("does not count a donation with a deduction year as a tax payment", async () => {
    const { user, account } = await setup();
    const donation = pay(user.id, account.id, 5000, "2025-01-10", {
      deductionYear: 2024,
    });
    const taxPayment = pay(user.id, account.id, 100000, "2024-03-10");
    setTransactionTaxYear(user.id, taxPayment.id, 2024);
    expect(paymentLines(user.id, 2024).map((l) => l.transactionId)).toEqual([
      taxPayment.id,
    ]);
    expect(donation.deductionYear).toBe(2024);
    expect(listTaxYears(user.id).map((y) => y.year)).toEqual([2024]);
  });

  it("counts payments allocated to bills tagged with the year", async () => {
    const { user, account } = await setup();
    const bill = seedBill(user.id, {
      creditorName: "Example Tax Office",
      amount: minor(120000),
      taxYear: 2025,
    });
    const tx = pay(user.id, account.id, 120000, "2025-04-01");
    allocate(user.id, bill.id, tx.id, minor(120000), "user");
    seedBill(user.id, { taxYear: 2025, amount: minor(5000) });

    const lines = paymentLines(user.id, 2025);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      transactionId: tx.id,
      amount: 120000,
      via: "bill",
      billIds: [bill.id],
      label: "Example Tax Office",
    });
  });

  it("counts a transaction once when it is tagged and its bill is too", async () => {
    const { user, account } = await setup();
    const bill = seedBill(user.id, { amount: minor(120000), taxYear: 2025 });
    const tx = pay(user.id, account.id, 120000, "2025-04-01");
    allocate(user.id, bill.id, tx.id, minor(120000), "user");
    setTransactionTaxYear(user.id, tx.id, 2025);

    const lines = paymentLines(user.id, 2025);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.via).toBe("tagged");
    expect(reconcileYear(user.id, 2025)!.balance.paidByMe).toBe(120000);
  });

  it("does not count a transaction tagged with another year through a bill", async () => {
    const { user, account } = await setup();
    const bill = seedBill(user.id, { amount: minor(120000), taxYear: 2025 });
    const tx = pay(user.id, account.id, 120000, "2025-04-01");
    allocate(user.id, bill.id, tx.id, minor(120000), "user");
    setTransactionTaxYear(user.id, tx.id, 2024);

    expect(paymentLines(user.id, 2025)).toEqual([]);
    expect(paymentLines(user.id, 2024)).toHaveLength(1);
  });

  it("counts a received refund against the payments", async () => {
    const { user, account } = await setup();
    setTransactionTaxYear(
      user.id,
      pay(user.id, account.id, 300000, "2025-03-10").id,
      2025,
    );
    const refund = seedImportedTransaction(user.id, account.id, {
      amount: minor(20000),
      bookingDate: "2026-02-01",
    });
    setTransactionTaxYear(user.id, refund.id, 2025);
    upsertTaxYear(user.id, yearInput({ assessedTotal: "2800.00" }));
    addTaxCredit(user.id, 2025, credit("2025-03-11", "3000.00"));
    addTaxCredit(user.id, 2025, credit("2026-02-02", "-200.00"));

    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.reconciled).toBe(true);
    expect(rec.balance).toMatchObject({ paidByMe: 280000, outcome: "settled" });
  });

  it("leaves payments in another currency out and says so", async () => {
    const { user, account } = await setup();
    const eur = seedAccount(user.id, { name: "Euro", currency: "EUR" });
    setTransactionTaxYear(
      user.id,
      pay(user.id, account.id, 1000, "2025-03-10").id,
      2025,
    );
    setTransactionTaxYear(
      user.id,
      pay(user.id, eur.id, 5000, "2025-03-10", { currency: "EUR" }).id,
      2025,
    );
    upsertTaxYear(user.id, yearInput());
    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.balance.paidByMe).toBe(1000);
    expect(rec.otherCurrencyLines).toBe(1);
  });

  it("derives a year from tagged payments before any details exist", async () => {
    const { user, account } = await setup();
    setTransactionTaxYear(
      user.id,
      pay(user.id, account.id, 1000, "2025-03-10").id,
      2025,
    );
    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.year).toMatchObject({
      id: null,
      currency: "CHF",
      assessedTotal: null,
    });
    expect(rec.balance.outcome).toBe("unknown");
    expect(reconcileYear(user.id, 2024)).toBeNull();

    addTaxCredit(user.id, 2025, credit("2025-03-11", "10.00"));
    expect(getTaxYear(user.id, 2025).id).not.toBeNull();
  });

  it("suggests untagged transactions for lines missing on your side", async () => {
    const { user, account } = await setup();
    upsertTaxYear(user.id, yearInput());
    const line = addTaxCredit(user.id, 2025, credit("2025-03-11", "1000.00"));
    const candidate = pay(user.id, account.id, 100000, "2025-03-09");
    pay(user.id, account.id, 99999, "2025-03-09");
    pay(user.id, account.id, 100000, "2025-08-09");

    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.counts.missing_mine).toBe(1);
    expect(rec.suggestions).toEqual([
      expect.objectContaining({
        creditId: line.id,
        transactionId: candidate.id,
      }),
    ]);

    setTransactionTaxYear(user.id, candidate.id, 2025);
    const after = reconcileYear(user.id, 2025)!;
    expect(after.reconciled).toBe(true);
    expect(after.suggestions).toEqual([]);
  });

  it("clears a tag with null", async () => {
    const { user, account } = await setup();
    const tx = pay(user.id, account.id, 1000, "2025-03-10");
    setTransactionTaxYear(user.id, tx.id, 2025);
    setTransactionTaxYear(user.id, tx.id, null);
    expect(paymentLines(user.id, 2025)).toEqual([]);
    expect(listTaxYears(user.id)).toEqual([]);
  });

  it("lists years newest first with their balance", async () => {
    const { user, account } = await setup();
    upsertTaxYear(user.id, yearInput({ year: "2024", assessedTotal: "10.00" }));
    setTransactionTaxYear(
      user.id,
      pay(user.id, account.id, 1000, "2025-03-10").id,
      2025,
    );
    seedBill(user.id, { taxYear: 2023 });

    const list = listTaxYears(user.id);
    expect(list.map((y) => y.year)).toEqual([2025, 2024, 2023]);
    expect(list[0]).toMatchObject({ discrepancies: 1, reconciled: false });
    expect(list[1]!.balance.outcome).toBe("due");
  });

  it("deletes a year's details and statement but keeps tags", async () => {
    const { user, account } = await setup();
    setTransactionTaxYear(
      user.id,
      pay(user.id, account.id, 1000, "2025-03-10").id,
      2025,
    );
    upsertTaxYear(user.id, yearInput());
    addTaxCredit(user.id, 2025, credit("2025-03-11", "10.00"));
    deleteTaxYear(user.id, 2025);
    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.year.id).toBeNull();
    expect(rec.counts.missing_mine).toBe(0);
    expect(rec.counts.missing_office).toBe(1);
  });

  it("updates the details of an existing year in place", async () => {
    const { user } = await setup();
    upsertTaxYear(user.id, yearInput({ authority: "A" }));
    const again = upsertTaxYear(
      user.id,
      yearInput({ authority: "B", assessedTotal: "5.00", notes: "n" }),
    );
    expect(again).toMatchObject({
      authority: "B",
      assessedTotal: 500,
      notes: "n",
    });
  });
});

describe("tax user scoping", () => {
  useTestDB();

  it("never mixes in another user's payments, bills or statement lines", async () => {
    const { user: a, account: accA } = await setup();
    const { user: b, account: accB } = await setup();
    setTransactionTaxYear(
      a.id,
      pay(a.id, accA.id, 1000, "2025-03-10").id,
      2025,
    );
    seedBill(a.id, { taxYear: 2022 });
    upsertTaxYear(a.id, yearInput());
    addTaxCredit(a.id, 2025, credit("2025-03-11", "10.00"));

    expect(listTaxYears(b.id)).toEqual([]);
    expect(reconcileYear(b.id, 2025)).toBeNull();
    expect(paymentLines(b.id, 2025)).toEqual([]);

    setTransactionTaxYear(
      b.id,
      pay(b.id, accB.id, 7777, "2025-05-05").id,
      2025,
    );
    const recB = reconcileYear(b.id, 2025)!;
    expect(recB.balance).toMatchObject({ paidByMe: 7777, creditedByOffice: 0 });
    expect(recB.year.id).toBeNull();
    const recA = reconcileYear(a.id, 2025)!;
    expect(recA.balance).toMatchObject({
      paidByMe: 1000,
      creditedByOffice: 1000,
    });
  });

  it("refuses to tag, or remove lines of, another user's rows", async () => {
    const { user: a, account: accA } = await setup();
    const { user: b } = await setup();
    const tx = pay(a.id, accA.id, 1000, "2025-03-10");
    upsertTaxYear(a.id, yearInput());
    const line = addTaxCredit(a.id, 2025, credit("2025-03-11", "10.00"));

    expect(
      (await fails(() => setTransactionTaxYear(b.id, tx.id, 2025))).code,
    ).toBe("not_found");
    expect((await fails(() => deleteTaxCredit(b.id, line.id))).code).toBe(
      "not_found",
    );
    expect((await fails(() => deleteTaxYear(b.id, 2025))).code).toBe(
      "not_found",
    );
    expect((await fails(() => getTaxYear(b.id, 2025))).code).toBe("not_found");
    expect(paymentLines(a.id, 2025)).toEqual([]);
    expect(reconcileYear(a.id, 2025)!.counts.missing_mine).toBe(1);
  });

  it("does not count another user's allocation against my bill", async () => {
    const { user: a, account: accA } = await setup();
    const { user: b } = await setup();
    const bill = seedBill(b.id, { taxYear: 2025, amount: minor(1000) });
    const tx = pay(a.id, accA.id, 1000, "2025-03-10");
    expect(() => allocate(b.id, bill.id, tx.id, minor(1000), "user")).toThrow();
    expect(paymentLines(b.id, 2025)).toEqual([]);
  });
});

describe("tax input schemas", () => {
  it("validates the year, the assessment and the currency", () => {
    expect(
      taxYearInputSchema.safeParse({ year: "25", currency: "CHF" }).success,
    ).toBe(false);
    expect(
      taxYearInputSchema.safeParse({
        year: "2025",
        currency: "CHF",
        assessedTotal: "-1",
      }).success,
    ).toBe(false);
    expect(
      taxYearInputSchema.safeParse({ year: "2025", currency: "ch" }).success,
    ).toBe(false);
    const ok = taxYearInputSchema.parse({
      year: "2025",
      currency: "chf",
      assessedTotal: "1'234.50",
      authority: " ",
    });
    expect(ok).toMatchObject({
      assessedTotal: 123450,
      authority: null,
      currency: "CHF",
    });
  });

  it("accepts signed, non-zero statement amounts and normalises the reference", () => {
    const schema = taxCreditInputSchema("CHF");
    const ok = schema.parse({
      bookingDate: "2025-03-11",
      amount: "-12.50",
      reference: " ab 12 ",
    });
    expect(ok).toMatchObject({ amount: -1250, reference: "AB12" });
    expect(
      schema.safeParse({ bookingDate: "2025-03-11", amount: "0" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ bookingDate: "2025-02-30", amount: "1" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ bookingDate: "2025-03-11", amount: "x" }).success,
    ).toBe(false);
  });
});
