import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { budgetReport, createBudget, spendingByCategory } from "./budgets";
import { createCategory } from "./categories";

useTestDB();

const m = minor;
const category = (name: string, parentId: string | null = null) => ({
  name,
  kind: "expense" as const,
  parentId,
  color: null,
  icon: null,
});

async function setup() {
  const user = await createTestUser();
  const full = await seedAccount(user.id, { name: "Full" });
  const half = await seedAccount(user.id, { name: "Half", shareBps: 5000 });
  const seventy = await seedAccount(user.id, {
    name: "Seventy",
    shareBps: 7000,
  });
  const euro = await seedAccount(user.id, {
    name: "Euro",
    currency: "EUR",
    shareBps: 5000,
  });
  const groceries = await createCategory(user.id, category("Groceries"));
  const dairy = await createCategory(user.id, category("Dairy", groceries.id));
  const spend = async (
    accountId: string,
    categoryId: string | null,
    amount: number,
    currency = "CHF",
  ) =>
    await seedImportedTransaction(user.id, accountId, {
      categoryId,
      amount: m(amount),
      bookingDate: "2026-10-05",
      currency,
    });
  await spend(full.id, groceries.id, -2000);
  await spend(half.id, groceries.id, -3001);
  await spend(half.id, groceries.id, 501); // refund
  await spend(seventy.id, dairy.id, -1001);
  await spend(euro.id, groceries.id, -5, "EUR");
  await spend(half.id, null, -999); // uncategorised
  return { user, groceries, dairy };
}

describe("budgets and spending at the ownership share", () => {
  it("counts shared transactions at their share, refunds netted", async () => {
    const { user, groceries } = await setup();
    await createBudget(user.id, {
      categoryId: groceries.id,
      currency: "CHF",
      amount: m(5000),
    });

    const total = await budgetReport(user.id, "2026-10", "total");
    const share = await budgetReport(user.id, "2026-10", "share");
    const row = (r: typeof total) =>
      r.currencies.find((c) => c.currency === "CHF")!.rows[0]!;

    // total: 2000 + 3001 - 501 + 1001 = 5501, over a budget of 5000
    expect(row(total)).toMatchObject({ spent: 5501, over: true });
    // share: 2000 + 1501 - 251 + 701 = 3951
    expect(row(share)).toMatchObject({
      spent: 3951,
      remaining: 1049,
      over: false,
    });
    expect(
      (await budgetReport(user.id, "2026-10")).currencies[0]!.rows[0]!.spent,
    ).toBe(5501);
    const eur = share.currencies.find((c) => c.currency === "EUR")!;
    expect(eur.unbudgeted[0]!.spent).toBe(3);
  });

  it("applies the same rule to the category totals", async () => {
    const { user, groceries } = await setup();
    const total = await spendingByCategory(user.id, "2026-10", "total");
    const share = await spendingByCategory(user.id, "2026-10", "share");
    const chf = (s: typeof total) =>
      s.currencies.find((c) => c.currency === "CHF")!;
    expect(chf(total).items).toMatchObject([
      { categoryId: groceries.id, spent: 5501 },
    ]);
    expect(chf(share).items).toMatchObject([
      { categoryId: groceries.id, spent: 3951 },
    ]);
    expect(chf(share).total).toBe(3951);
    expect(share.currencies.find((c) => c.currency === "EUR")!.total).toBe(3);
    expect(share.uncategorizedCount).toBe(1);
  });

  it("never scales the stored amounts and leaves other users alone", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    const a = await seedAccount(other.id, { shareBps: 5000 });
    const cat = await createCategory(other.id, category("Other"));
    await seedImportedTransaction(other.id, a.id, {
      categoryId: cat.id,
      amount: m(-1000),
      bookingDate: "2026-10-05",
    });
    expect(
      (
        await spendingByCategory(user.id, "2026-10", "share")
      ).currencies.flatMap((c) => c.items.map((i) => i.name)),
    ).not.toContain("Other");
    expect(
      (await spendingByCategory(other.id, "2026-10", "share")).currencies[0]!
        .total,
    ).toBe(500);
    expect(
      (await spendingByCategory(other.id, "2026-10", "total")).currencies[0]!
        .total,
    ).toBe(1000);
  });
});
