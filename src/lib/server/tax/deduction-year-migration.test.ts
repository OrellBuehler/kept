import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { categories, deductionYearMigration } from "$lib/server/db/schema";
import { transactions } from "$lib/server/db/schema";
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
import { first, withExclusiveClient } from "$lib/server/db";

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

  const cat = async (
    userId: string,
    name: string,
    parentId: string | null = null,
  ) =>
    await createCategory(userId, {
      name,
      kind: "expense",
      parentId,
      color: null,
      icon: null,
    });
  const run = () =>
    withExclusiveClient((client) => {
      for (const statement of dataStatements) client.run(statement);
    });
  const read = async (id: string) =>
    await first(
      ctx.db
        .select({
          taxYear: transactions.taxYear,
          deductionYear: transactions.deductionYear,
        })
        .from(transactions)
        .where(eq(transactions.id, id))
        .limit(1),
    );

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
    const gifts = await cat(user.id, "Gifts");
    const church = await cat(user.id, "Church", gifts.id);
    const taxes = await cat(user.id, "Taxes");
    await setCategoryDeduction(user.id, gifts.id, "donations");

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

    await upsertTaxYear(user.id, yearInput("2024"));
    await addTaxCredit(user.id, 2024, creditInput("700.00"));
    // Another user's credit for the same amount must not protect this user's rows.
    await upsertTaxYear(other.id, yearInput("2024"));
    await addTaxCredit(other.id, 2024, creditInput("50.00"));

    await run();

    expect(await read(donation.id)).toEqual({
      taxYear: null,
      deductionYear: 2024,
    });
    expect(await read(inherited.id)).toEqual({
      taxYear: null,
      deductionYear: 2024,
    });
    expect(await read(reconciled.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(await read(taxPaymentUncategorized.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(await read(taxPaymentOtherCategory.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(await read(untagged.id)).toEqual({
      taxYear: null,
      deductionYear: null,
    });
    expect(await read(refund.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });

    const records = await ctx.db.select().from(deductionYearMigration);
    expect(records.map((r) => r.transactionId).sort()).toEqual(
      [donation.id, inherited.id].sort(),
    );
    expect(records.every((r) => r.userId === user.id)).toBe(true);
    expect(records.every((r) => r.oldTaxYear === 2024)).toBe(true);
  });

  it("leaves a category mapped to other untouched, with no credits entered yet", async () => {
    const { user, tx } = await setup();
    const taxes = await cat(user.id, "Taxes");
    await setCategoryDeduction(user.id, taxes.id, "other");
    const payment = await tx({
      categoryId: taxes.id,
      amount: minor(-70000),
      taxYear: 2024,
    });

    await run();

    expect(await read(payment.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(await ctx.db.select().from(deductionYearMigration)).toHaveLength(0);
  });

  it("does not look past the direct parent, like the app", async () => {
    const { user, tx } = await setup();
    const top = await cat(user.id, "Top");
    const mid = await cat(user.id, "Mid", top.id);
    // The app allows two levels; build a third one directly.
    const leaf = (
      await ctx.db
        .insert(categories)
        .values({
          userId: user.id,
          name: "Leaf",
          kind: "expense",
          parentId: mid.id,
        })
        .returning()
    )[0]!;
    await setCategoryDeduction(user.id, top.id, "donations");
    const grandchild = await tx({ categoryId: leaf.id, taxYear: 2024 });
    const child = await tx({ categoryId: mid.id, taxYear: 2024 });

    await run();

    expect(await read(grandchild.id)).toEqual({
      taxYear: 2024,
      deductionYear: null,
    });
    expect(await read(child.id)).toEqual({
      taxYear: null,
      deductionYear: 2024,
    });
  });

  it("undo restores tax_year, clears deduction_year and deletes the records; dismiss only deletes them", async () => {
    const { user, tx } = await setup();
    const other = await createTestUser();
    const gifts = await cat(user.id, "Gifts");
    await setCategoryDeduction(user.id, gifts.id, "donations");
    const a = await tx({ categoryId: gifts.id, taxYear: 2024 });
    const b = await tx({ categoryId: gifts.id, taxYear: 2023 });
    const otherAccount = await seedAccount(other.id);
    const otherGifts = await cat(other.id, "Gifts");
    await setCategoryDeduction(other.id, otherGifts.id, "donations");
    const theirs = await seedImportedTransaction(other.id, otherAccount.id, {
      categoryId: otherGifts.id,
      taxYear: 2024,
      amount: minor(-5000),
    });
    await run();
    expect(await countDeductionYearMoves(user.id, 2024)).toBe(1);
    expect(await countDeductionYearMoves(other.id, 2024)).toBe(1);

    // Another user cannot undo or dismiss these.
    expect(await undoDeductionYearMoves(other.id, 2023)).toBe(0);
    expect(await read(b.id)).toEqual({ taxYear: null, deductionYear: 2023 });

    expect(await undoDeductionYearMoves(user.id, 2024)).toBe(1);
    expect(await read(a.id)).toEqual({ taxYear: 2024, deductionYear: null });
    expect(await read(b.id)).toEqual({ taxYear: null, deductionYear: 2023 });
    expect(await read(theirs.id)).toEqual({
      taxYear: null,
      deductionYear: 2024,
    });
    expect(await countDeductionYearMoves(user.id, 2024)).toBe(0);
    expect(await countDeductionYearMoves(other.id, 2024)).toBe(1);

    expect(await dismissDeductionYearMoves(user.id, 2023)).toBe(1);
    expect(await read(b.id)).toEqual({ taxYear: null, deductionYear: 2023 });
    expect(await countDeductionYearMoves(user.id, 2023)).toBe(0);
  });

  it("undo leaves a transaction alone that the user has changed since", async () => {
    const { user, tx } = await setup();
    const gifts = await cat(user.id, "Gifts");
    await setCategoryDeduction(user.id, gifts.id, "donations");
    const a = await tx({ categoryId: gifts.id, taxYear: 2024 });
    await run();
    await ctx.db
      .update(transactions)
      .set({ deductionYear: 2022 })
      .where(eq(transactions.id, a.id));

    expect(await undoDeductionYearMoves(user.id, 2024)).toBe(0);
    expect(await read(a.id)).toEqual({ taxYear: null, deductionYear: 2022 });
    expect(await countDeductionYearMoves(user.id, 2024)).toBe(0);
  });
});
