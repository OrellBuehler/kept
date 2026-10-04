import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { categories, deductionYearMigration } from "$lib/server/schema";
import { transactions } from "$lib/server/schema";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { setCategoryDeduction } from "./deductions";
import {
  countDeductionYearMoves,
  dismissDeductionYearMoves,
  undoDeductionYearMoves,
} from "./deduction-year-migration";
import { addTaxCredit, upsertTaxYear } from "./tax";
import { taxCreditInputSchema, taxYearInputSchema } from "./schemas";

const dir = join(process.cwd(), "drizzle");
const file = readdirSync(dir).find((f) =>
  f.startsWith("0021_reclassify_deduction_years"),
)!;
const dataStatements = readFileSync(join(dir, file), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const yearInput = (y: string) =>
  taxYearInputSchema.parse({
    year: y,
    authority: "",
    currency: "CHF",
    assessedTotal: "",
    notes: "",
  });
const creditInput = (amount: string) =>
  taxCreditInputSchema("CHF").parse({
    bookingDate: "2025-01-12",
    amount,
    reference: "",
    description: "",
  });

describe("deduction year data migration", () => {
  const ctx = useTestDB();

  const cat = (userId: string, name: string, parentId: string | null = null) =>
    createCategory(userId, {
      name,
      kind: "expense",
      parentId,
      color: null,
      icon: null,
    });
  const run = () => {
    for (const statement of dataStatements) ctx.db.$client.run(statement);
  };
  const read = (id: string) =>
    ctx.db
      .select({
        taxYear: transactions.taxYear,
        deductionYear: transactions.deductionYear,
      })
      .from(transactions)
      .where(eq(transactions.id, id))
      .get();

  function setup() {
    return (async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      const tx = async (over: Partial<typeof transactions.$inferInsert>) =>
        await seedImportedTransaction(user.id, account.id, {
          amount: minor(-5000),
          bookingDate: "2025-01-10",
          ...over,
        });
      return { user, account, tx };
    })();
  }

  it("moves tagged deduction-category rows that no tax-office line matches and records them", async () => {
    const { user, tx } = await setup();
    const other = await createTestUser();
    const gifts = cat(user.id, "Gifts");
    const church = cat(user.id, "Church", gifts.id);
    const taxes = cat(user.id, "Taxes");
    setCategoryDeduction(user.id, gifts.id, "donations");

    const donation = await tx({ categoryId: gifts.id, taxYear: 2024 });
    const inherited = await tx({ categoryId: church.id, taxYear: 2024 });
    const taxPaymentUncategorized = await tx({
      amount: minor(-70000),
      taxYear: 2024,
    });
    const taxPaymentOtherCategory = await tx({
      categoryId: taxes.id,
      amount: minor(-70000),
      taxYear: 2024,
    });
    const reconciled = await tx({
      categoryId: gifts.id,
      amount: minor(-70000),
      taxYear: 2024,
    });
    const untagged = await tx({ categoryId: gifts.id });
    const refund = await tx({
      categoryId: gifts.id,
      amount: minor(5000),
      taxYear: 2024,
    });

    upsertTaxYear(user.id, yearInput("2024"));
    addTaxCredit(user.id, 2024, creditInput("700.00"));
    // Another user's credit for the same amount must not protect this user's rows.
    upsertTaxYear(other.id, yearInput("2024"));
    addTaxCredit(other.id, 2024, creditInput("50.00"));

    run();

    expect(read(donation.id)).toEqual({ taxYear: null, deductionYear: 2024 });
    expect(read(inherited.id)).toEqual({ taxYear: null, deductionYear: 2024 });
    expect(read(reconciled.id)).toEqual({ taxYear: 2024, deductionYear: null });
    expect(read(taxPaymentUncategorized.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(read(taxPaymentOtherCategory.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(read(untagged.id)).toEqual({ taxYear: null, deductionYear: null });
    expect(read(refund.id)).toEqual({ taxYear: 2024, deductionYear: null });

    const records = ctx.db.select().from(deductionYearMigration).all();
    expect(records.map((r) => r.transactionId).sort()).toEqual(
      [donation.id, inherited.id].sort(),
    );
    expect(records.every((r) => r.userId === user.id)).toBe(true);
    expect(records.every((r) => r.oldTaxYear === 2024)).toBe(true);
  });

  it("leaves a category mapped to other untouched, with no credits entered yet", async () => {
    const { user, tx } = await setup();
    const taxes = cat(user.id, "Taxes");
    setCategoryDeduction(user.id, taxes.id, "other");
    const payment = await tx({
      categoryId: taxes.id,
      amount: minor(-70000),
      taxYear: 2024,
    });

    run();

    expect(read(payment.id)).toEqual({ taxYear: 2024, deductionYear: null });
    expect(ctx.db.select().from(deductionYearMigration).all()).toHaveLength(0);
  });

  it("does not look past the direct parent, like the app", async () => {
    const { user, tx } = await setup();
    const top = cat(user.id, "Top");
    const mid = cat(user.id, "Mid", top.id);
    // The app allows two levels; build a third one directly.
    const leaf = ctx.db
      .insert(categories)
      .values({
        userId: user.id,
        name: "Leaf",
        kind: "expense",
        parentId: mid.id,
      })
      .returning()
      .get();
    setCategoryDeduction(user.id, top.id, "donations");
    const grandchild = await tx({ categoryId: leaf.id, taxYear: 2024 });
    const child = await tx({ categoryId: mid.id, taxYear: 2024 });

    run();

    expect(read(grandchild.id)).toEqual({ taxYear: 2024, deductionYear: null });
    expect(read(child.id)).toEqual({ taxYear: null, deductionYear: 2024 });
  });

  it("undo restores tax_year, clears deduction_year and deletes the records; dismiss only deletes them", async () => {
    const { user, tx } = await setup();
    const other = await createTestUser();
    const gifts = cat(user.id, "Gifts");
    setCategoryDeduction(user.id, gifts.id, "donations");
    const a = await tx({ categoryId: gifts.id, taxYear: 2024 });
    const b = await tx({ categoryId: gifts.id, taxYear: 2023 });
    const otherAccount = await seedAccount(other.id);
    const otherGifts = cat(other.id, "Gifts");
    setCategoryDeduction(other.id, otherGifts.id, "donations");
    const theirs = await seedImportedTransaction(other.id, otherAccount.id, {
      categoryId: otherGifts.id,
      taxYear: 2024,
      amount: minor(-5000),
    });
    run();
    expect(countDeductionYearMoves(user.id, 2024)).toBe(1);
    expect(countDeductionYearMoves(other.id, 2024)).toBe(1);

    // Another user cannot undo or dismiss these.
    expect(undoDeductionYearMoves(other.id, 2023)).toBe(0);
    expect(read(b.id)).toEqual({ taxYear: null, deductionYear: 2023 });

    expect(undoDeductionYearMoves(user.id, 2024)).toBe(1);
    expect(read(a.id)).toEqual({ taxYear: 2024, deductionYear: null });
    expect(read(b.id)).toEqual({ taxYear: null, deductionYear: 2023 });
    expect(read(theirs.id)).toEqual({ taxYear: null, deductionYear: 2024 });
    expect(countDeductionYearMoves(user.id, 2024)).toBe(0);
    expect(countDeductionYearMoves(other.id, 2024)).toBe(1);

    expect(dismissDeductionYearMoves(user.id, 2023)).toBe(1);
    expect(read(b.id)).toEqual({ taxYear: null, deductionYear: 2023 });
    expect(countDeductionYearMoves(user.id, 2023)).toBe(0);
  });

  it("undo leaves a transaction alone that the user has changed since", async () => {
    const { user, tx } = await setup();
    const gifts = cat(user.id, "Gifts");
    setCategoryDeduction(user.id, gifts.id, "donations");
    const a = await tx({ categoryId: gifts.id, taxYear: 2024 });
    run();
    ctx.db
      .update(transactions)
      .set({ deductionYear: 2022 })
      .where(eq(transactions.id, a.id))
      .run();

    expect(undoDeductionYearMoves(user.id, 2024)).toBe(0);
    expect(read(a.id)).toEqual({ taxYear: null, deductionYear: 2022 });
    expect(countDeductionYearMoves(user.id, 2024)).toBe(0);
  });
});
