import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { dashboard } from "$lib/server/dashboard";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  budgetReport,
  createBudget,
  deleteBudget,
  listBudgets,
  spendingByCategory,
  updateBudget,
} from "./budgets";
import { createCategory } from "./categories";
import { budgetInputSchema, type CategoryInput } from "./schemas";

useTestDB();

const cat = (
  name: string,
  over: Partial<CategoryInput> = {},
): CategoryInput => ({
  name,
  kind: "expense",
  parentId: null,
  color: null,
  icon: null,
  ...over,
});

const budget = (categoryId: string, amount: number, currency = "CHF") => ({
  categoryId,
  currency,
  amount: minor(amount),
});

async function setup() {
  const user = await createTestUser();
  const chf = await seedAccount(user.id, { name: "Main" });
  const eur = await seedAccount(user.id, { name: "Euro", currency: "EUR" });
  const spend = async (
    accountId: string,
    categoryId: string | null,
    amount: number,
    bookingDate = "2026-10-05",
    currency = "CHF",
  ) =>
    await seedImportedTransaction(user.id, accountId, {
      categoryId,
      amount: minor(amount),
      bookingDate,
      currency,
    });
  return { user, chf, eur, spend };
}

describe("budget input", () => {
  it("parses the amount in the currency's minor units", () => {
    const r = budgetInputSchema.safeParse({
      categoryId: "c",
      currency: "chf",
      amount: "250.50",
    });
    expect(r.success && r.data).toEqual({
      categoryId: "c",
      currency: "CHF",
      amount: 25050,
    });
  });

  it("rejects zero, negative and malformed amounts", () => {
    for (const amount of ["0", "-5", "abc", "1.234"]) {
      expect(
        budgetInputSchema.safeParse({
          categoryId: "c",
          currency: "CHF",
          amount,
        }).success,
      ).toBe(false);
    }
  });
});

describe("budgets", () => {
  it("creates, updates and deletes; one budget per category and currency", async () => {
    const { user } = await setup();
    const food = await createCategory(user.id, cat("Food"));
    const b = await createBudget(user.id, budget(food.id, 40000));
    await expect(createBudget(user.id, budget(food.id, 1))).rejects.toThrow(
      /already has a budget/,
    );
    await createBudget(user.id, budget(food.id, 30000, "EUR"));
    await updateBudget(user.id, b.id, budget(food.id, 50000));
    expect(
      (await listBudgets(user.id)).find((x) => x.id === b.id)!.amount,
    ).toBe(50000);
    await deleteBudget(user.id, b.id);
    expect(await listBudgets(user.id)).toHaveLength(1);
  });

  it("only allows budgets on own expense categories", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    const salary = await createCategory(
      user.id,
      cat("Salary", { kind: "income" }),
    );
    const theirs = await createCategory(other.id, cat("Theirs"));
    await expect(createBudget(user.id, budget(salary.id, 100))).rejects.toThrow(
      /expense categories/,
    );
    await expect(createBudget(user.id, budget(theirs.id, 100))).rejects.toThrow(
      /choose a category/i,
    );
  });

  it("is scoped to the user", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    const food = await createCategory(user.id, cat("Food"));
    const b = await createBudget(user.id, budget(food.id, 100));
    expect(await listBudgets(other.id)).toEqual([]);
    await expect(deleteBudget(other.id, b.id)).rejects.toThrow(/not found/i);
    await expect(
      updateBudget(other.id, b.id, budget(food.id, 5)),
    ).rejects.toThrow(/not found/i);
  });
});

describe("budget report", () => {
  it("sums spending per category and month, nets refunds, rolls up subcategories", async () => {
    const { user, chf, spend } = await setup();
    const food = await createCategory(user.id, cat("Food"));
    const groceries = await createCategory(
      user.id,
      cat("Groceries", { parentId: food.id }),
    );
    await createBudget(user.id, budget(food.id, 40000));
    await createBudget(user.id, budget(groceries.id, 20000));
    await spend(chf.id, food.id, -10000);
    await spend(chf.id, groceries.id, -15000);
    await spend(chf.id, groceries.id, 2000);
    await spend(chf.id, groceries.id, -99999, "2026-09-30");
    await spend(chf.id, groceries.id, -99999, "2026-11-01");
    await spend(chf.id, null, -5000);

    const report = await budgetReport(user.id, "2026-10");
    expect(report.month).toBe("2026-10");
    expect(report.currencies).toHaveLength(1);
    const chfReport = report.currencies[0]!;
    expect(chfReport.rows).toMatchObject([
      {
        categoryName: "Food",
        budget: 40000,
        spent: 23000,
        remaining: 17000,
        over: false,
      },
      {
        categoryName: "Groceries",
        parentName: "Food",
        budget: 20000,
        spent: 13000,
        remaining: 7000,
        over: false,
      },
    ]);
    expect(chfReport.unbudgeted).toEqual([]);
    expect(chfReport.totalBudget).toBe(40000);
    expect(chfReport.totalSpent).toBe(23000);
  });

  it("flags overspending and lists unbudgeted spending", async () => {
    const { user, chf, spend } = await setup();
    const fun = await createCategory(user.id, cat("Fun"));
    const rent = await createCategory(user.id, cat("Rent"));
    const salary = await createCategory(
      user.id,
      cat("Salary", { kind: "income" }),
    );
    await createBudget(user.id, budget(fun.id, 5000));
    await spend(chf.id, fun.id, -7000);
    await spend(chf.id, rent.id, -90000);
    await spend(chf.id, salary.id, 500000);

    const r = (await budgetReport(user.id, "2026-10")).currencies[0]!;
    expect(r.rows[0]).toMatchObject({ over: true, remaining: -2000 });
    expect(r.unbudgeted).toMatchObject([
      { categoryName: "Rent", spent: 90000 },
    ]);
  });

  it("keeps currencies apart and never converts", async () => {
    const { user, chf, eur, spend } = await setup();
    const food = await createCategory(user.id, cat("Food"));
    await createBudget(user.id, budget(food.id, 10000, "CHF"));
    await createBudget(user.id, budget(food.id, 8000, "EUR"));
    await spend(chf.id, food.id, -4000);
    await spend(eur.id, food.id, -9000, "2026-10-06", "EUR");

    const report = await budgetReport(user.id, "2026-10");
    expect(report.currencies.map((c) => c.currency)).toEqual(["CHF", "EUR"]);
    expect(report.currencies[0]!.rows[0]).toMatchObject({
      spent: 4000,
      over: false,
    });
    expect(report.currencies[1]!.rows[0]).toMatchObject({
      spent: 9000,
      over: true,
    });
  });

  it("shows a budget with no spending", async () => {
    const { user } = await setup();
    const food = await createCategory(user.id, cat("Food"));
    await createBudget(user.id, budget(food.id, 10000));
    const r = (await budgetReport(user.id, "2026-10")).currencies[0]!;
    expect(r.rows[0]).toMatchObject({
      spent: 0,
      remaining: 10000,
      over: false,
    });
  });

  it("only counts the user's own transactions and categories", async () => {
    const { user, chf, spend } = await setup();
    const other = await createTestUser();
    const otherAccount = await seedAccount(other.id);
    const food = await createCategory(user.id, cat("Food"));
    const theirFood = await createCategory(other.id, cat("Food"));
    await createBudget(user.id, budget(food.id, 10000));
    await createBudget(other.id, budget(theirFood.id, 99900));
    await spend(chf.id, food.id, -1000);
    await seedImportedTransaction(other.id, otherAccount.id, {
      categoryId: theirFood.id,
      amount: minor(-77700),
      bookingDate: "2026-10-05",
    });

    const mine = (await budgetReport(user.id, "2026-10")).currencies;
    expect(mine).toHaveLength(1);
    expect(mine[0]!.rows).toHaveLength(1);
    expect(mine[0]!.rows[0]!.spent).toBe(1000);
    expect(
      (await spendingByCategory(user.id, "2026-10")).currencies[0]!.total,
    ).toBe(1000);
    expect(
      (await budgetReport(other.id, "2026-10")).currencies[0]!.rows[0]!.spent,
    ).toBe(77700);
  });
});

describe("spending by category", () => {
  it("rolls subcategories into their parent, sorts by amount and ignores income", async () => {
    const { user, chf, eur, spend } = await setup();
    const food = await createCategory(user.id, cat("Food"));
    const groceries = await createCategory(
      user.id,
      cat("Groceries", { parentId: food.id }),
    );
    const home = await createCategory(user.id, cat("Home"));
    const salary = await createCategory(
      user.id,
      cat("Salary", { kind: "income" }),
    );
    await spend(chf.id, groceries.id, -3000);
    await spend(chf.id, food.id, -2000);
    await spend(chf.id, home.id, -6000);
    await spend(chf.id, salary.id, 100000);
    await spend(eur.id, home.id, -700, "2026-10-09", "EUR");
    await spend(chf.id, null, -100);
    await spend(chf.id, null, 100);
    await spend(chf.id, null, -100, "2026-09-01");

    const s = await spendingByCategory(user.id, "2026-10");
    expect(s.currencies.map((c) => [c.currency, c.total])).toEqual([
      ["CHF", 11000],
      ["EUR", 700],
    ]);
    expect(s.currencies[0]!.items.map((i) => [i.name, i.spent])).toEqual([
      ["Home", 6000],
      ["Food", 5000],
    ]);
    expect(s.uncategorizedCount).toBe(1);
  });

  it("is part of the dashboard", async () => {
    const { user, chf, spend } = await setup();
    const food = await createCategory(user.id, cat("Food"));
    await spend(chf.id, food.id, -1200, "2026-10-02");
    const d = await dashboard(user.id, "2026-10-15");
    expect(d.spending.month).toBe("2026-10");
    expect(d.spending.currencies[0]!.items[0]).toMatchObject({
      name: "Food",
      spent: 1200,
    });
  });
});

describe("budget writes check and write in one transaction", () => {
  it("refuses a second budget for the same category and currency, but not a self-update", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, cat("Food"));
    const first = await createBudget(u.id, budget(food.id, 50000));
    await expect(
      createBudget(u.id, budget(food.id, 1000)),
    ).rejects.toMatchObject({ code: "conflict", field: "categoryId" });
    await expect(
      createBudget(u.id, budget(food.id, 1000, "EUR")),
    ).resolves.toMatchObject({ currency: "EUR" });
    await expect(
      updateBudget(u.id, first.id, budget(food.id, 60000)),
    ).resolves.toMatchObject({ amount: 60000 });
    expect(await listBudgets(u.id)).toHaveLength(2);
  });

  it("changes nothing when an update is refused, and keeps users apart", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const food = await createCategory(a.id, cat("Food"));
    const income = await createCategory(a.id, cat("Pay", { kind: "income" }));
    const theirs = await createCategory(b.id, cat("Food"));
    const created = await createBudget(a.id, budget(food.id, 50000));
    await expect(
      updateBudget(a.id, created.id, budget(income.id, 1)),
    ).rejects.toMatchObject({ code: "invalid", field: "categoryId" });
    await expect(
      updateBudget(a.id, created.id, budget(theirs.id, 1)),
    ).rejects.toMatchObject({ code: "invalid", field: "categoryId" });
    await expect(
      updateBudget(b.id, created.id, budget(theirs.id, 1)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await listBudgets(a.id)).toEqual([
      expect.objectContaining({ categoryId: food.id, amount: 50000 }),
    ]);
    expect(await listBudgets(b.id)).toEqual([]);
  });
});
