import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { transactions } from "$lib/server/schema";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { eq } from "drizzle-orm";
import { setCategoryDeduction } from "./deductions";
import { addTaxCredit, upsertTaxYear } from "./tax";
import { taxCreditInputSchema, taxYearInputSchema } from "./schemas";

const dir = join(process.cwd(), "drizzle");
const file = readdirSync(dir).find((f) => f.startsWith("0019_"))!;
const dataStatements = readFileSync(join(dir, file), "utf8")
  .split("--> statement-breakpoint")
  .filter((s) => /\bUPDATE\b/.test(s));

describe("0019 migration: split tax_year into tax payment and deduction year", () => {
  const ctx = useTestDB();

  it("moves tagged deduction-category rows that no tax-office line matches", async () => {
    expect(dataStatements).toHaveLength(1);
    const user = await createTestUser();
    const other = await createTestUser();
    const account = seedAccount(user.id);
    const cat = (
      userId: string,
      name: string,
      parentId: string | null = null,
    ) =>
      createCategory(userId, {
        name,
        kind: "expense",
        parentId,
        color: null,
        icon: null,
      });
    const gifts = cat(user.id, "Gifts");
    const church = cat(user.id, "Church", gifts.id);
    const taxes = cat(user.id, "Taxes");
    setCategoryDeduction(user.id, gifts.id, "donations");

    const tx = (over: Partial<typeof transactions.$inferInsert>) =>
      seedImportedTransaction(user.id, account.id, {
        amount: minor(-5000),
        bookingDate: "2025-01-10",
        ...over,
      });
    const donation = tx({ categoryId: gifts.id, taxYear: 2024 });
    const inherited = tx({ categoryId: church.id, taxYear: 2024 });
    const taxPaymentUncategorized = tx({
      amount: minor(-70000),
      taxYear: 2024,
    });
    const taxPaymentOtherCategory = tx({
      categoryId: taxes.id,
      amount: minor(-70000),
      taxYear: 2024,
    });
    // maps to a deduction type, but the tax office counted exactly this amount
    const reconciled = tx({
      categoryId: gifts.id,
      amount: minor(-70000),
      taxYear: 2024,
    });
    const untagged = tx({ categoryId: gifts.id });

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
    upsertTaxYear(user.id, yearInput("2024"));
    addTaxCredit(user.id, 2024, creditInput("700.00"));

    // Another user's credit for the same amount must not protect this user's rows.
    upsertTaxYear(other.id, yearInput("2024"));
    addTaxCredit(other.id, 2024, creditInput("50.00"));

    for (const statement of dataStatements) ctx.db.$client.run(statement);

    const read = (id: string) =>
      ctx.db
        .select({
          taxYear: transactions.taxYear,
          deductionYear: transactions.deductionYear,
        })
        .from(transactions)
        .where(eq(transactions.id, id))
        .get();

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
  });
});
