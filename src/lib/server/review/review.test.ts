import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import type { CategoryInput } from "$lib/server/categories/schemas";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { IBAN_CH_SPACED, IBAN_DE } from "$lib/testing/fixtures/values";
import { setAccountArchived } from "$lib/server/ledger";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  defaultReviewYear,
  reviewYears,
  yearReview,
  yearSchema,
} from "./index";

const TODAY = "2026-10-15";
const m = minor;
const expense = {
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
};
const income = {
  kind: "income" as const,
  parentId: null,
  color: null,
  icon: null,
};

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id, { openingBalance: m(100000) });
  const cat = (name: string, over: Partial<CategoryInput> = {}) =>
    createCategory(user.id, { name, ...expense, ...over });
  const tx = (
    amount: number,
    bookingDate: string,
    over: Parameters<typeof seedImportedTransaction>[2] = {},
  ) =>
    seedImportedTransaction(user.id, account.id, {
      amount: m(amount),
      bookingDate,
      ...over,
    });
  return { user, account, cat, tx };
}

describe("review years", () => {
  useTestDB();

  it("validates the year against today", () => {
    const schema = yearSchema(TODAY);
    expect(schema.safeParse("2025").success).toBe(true);
    expect(schema.safeParse("2026").success).toBe(true);
    expect(schema.safeParse("2027").success).toBe(false);
    expect(schema.safeParse("abc").success).toBe(false);
    expect(schema.safeParse("2025.5").success).toBe(false);
  });

  it("defaults to the last full year when it has data", () => {
    expect(defaultReviewYear(TODAY, [2026, 2025])).toBe(2025);
    expect(defaultReviewYear(TODAY, [2026])).toBe(2026);
    expect(defaultReviewYear(TODAY, [])).toBe(2026);
  });

  it("lists years with transactions on active accounts, newest first", async () => {
    const { user, tx } = await setup();
    const other = await createTestUser();
    const otherAccount = seedAccount(other.id);
    seedImportedTransaction(other.id, otherAccount.id, {
      bookingDate: "2019-05-05",
    });
    const archived = seedAccount(user.id, { name: "Old" });
    seedImportedTransaction(user.id, archived.id, {
      bookingDate: "2018-05-05",
    });
    setAccountArchived(user.id, archived.id, true);
    tx(-10, "2024-02-01");
    tx(-10, "2025-02-01");
    tx(-10, "2025-03-01");
    expect(reviewYears(user.id)).toEqual([2025, 2024]);
  });
});

describe("yearReview", () => {
  useTestDB();

  it("is empty without transactions", async () => {
    const user = await createTestUser();
    seedAccount(user.id);
    const r = yearReview(user.id, { year: 2025, today: TODAY });
    expect(r).toMatchObject({
      year: 2025,
      from: "2025-01-01",
      to: "2025-12-31",
      partial: false,
      excludedTransfers: 0,
      currencies: [],
    });
  });

  it("totals income and expenses with refunds netted into their category", async () => {
    const { cat, tx, user } = await setup();
    const salary = cat("Salary", income);
    const food = cat("Food");
    const rent = cat("Rent");
    tx(5000, "2025-01-25", { categoryId: salary.id });
    tx(5000, "2025-02-25", { categoryId: salary.id });
    tx(-800, "2025-01-03", { categoryId: rent.id });
    tx(-120, "2025-02-10", { categoryId: food.id });
    tx(30, "2025-02-12", { categoryId: food.id });
    tx(-50, "2025-03-01");
    tx(-9999, "2024-12-31", { categoryId: food.id });
    tx(-9999, "2026-01-01", { categoryId: food.id });

    const r = yearReview(user.id, { year: 2025, today: TODAY });
    const chf = r.currencies[0]!;
    expect(r.currencies).toHaveLength(1);
    expect(chf).toMatchObject({
      currency: "CHF",
      income: 10000,
      expenses: 800 + 90 + 50,
      net: 10000 - 940,
    });
    expect(chf.savingsRate).toBeCloseTo(0.906);
    expect(chf.months[0]).toEqual({
      month: "2025-01",
      income: 5000,
      expenses: 800,
    });
    expect(chf.months[1]).toEqual({
      month: "2025-02",
      income: 5000,
      expenses: 90,
    });
    expect(chf.months[2]).toEqual({
      month: "2025-03",
      income: 0,
      expenses: 50,
    });
    expect(chf.months).toHaveLength(12);

    const right = chf.sankey.right.map((n) => [n.label, n.value]);
    expect(right).toEqual([
      ["Rent", 800],
      ["Food", 90],
      ["Uncategorized", 50],
      ["Saved", 9060],
    ]);
    expect(chf.sankey.left.map((n) => [n.label, n.value])).toEqual([
      ["Salary", 10000],
    ]);
    expect(chf.sankey.total?.value).toBe(10000);
  });

  it("rolls subcategories up into their parent", async () => {
    const { cat, tx, user } = await setup();
    const food = cat("Food");
    const groceries = cat("Groceries", { parentId: food.id });
    tx(-100, "2025-04-01", { categoryId: food.id });
    tx(-50, "2025-04-02", { categoryId: groceries.id });
    const chf = yearReview(user.id, { year: 2025, today: TODAY })
      .currencies[0]!;
    expect(chf.sankey.right.find((n) => n.label === "Food")?.value).toBe(150);
    expect(
      chf.sankey.right.find((n) => n.label === "Groceries"),
    ).toBeUndefined();
  });

  it("handles a year without a previous year", async () => {
    const { cat, tx, user } = await setup();
    tx(-100, "2025-04-01", { categoryId: cat("Food").id });
    const chf = yearReview(user.id, { year: 2025, today: TODAY })
      .currencies[0]!;
    expect(chf.hasPreviousYear).toBe(false);
    expect(chf.changes).toEqual([]);
  });

  it("computes year-over-year changes in both directions", async () => {
    const { cat, tx, user } = await setup();
    const food = cat("Food");
    const travel = cat("Travel");
    const fun = cat("Fun");
    const salary = cat("Salary", income);
    tx(-100, "2024-04-01", { categoryId: food.id });
    tx(-400, "2024-05-01", { categoryId: travel.id });
    tx(-10, "2024-05-01", { categoryId: fun.id });
    tx(1000, "2024-05-01", { categoryId: salary.id });
    tx(-300, "2025-04-01", { categoryId: food.id });
    tx(-100, "2025-05-01", { categoryId: travel.id });
    tx(-60, "2025-05-01", { categoryId: cat("New").id });
    tx(1500, "2025-05-01", { categoryId: salary.id });

    const chf = yearReview(user.id, { year: 2025, today: TODAY })
      .currencies[0]!;
    expect(chf.hasPreviousYear).toBe(true);
    const byName = Object.fromEntries(chf.changes.map((c) => [c.name, c]));
    expect(byName.Food).toMatchObject({
      amount: 300,
      previous: 100,
      change: 200,
      changePct: 2,
    });
    expect(byName.Travel).toMatchObject({ change: -300, changePct: -0.75 });
    expect(byName.New).toMatchObject({
      previous: 0,
      change: 60,
      changePct: null,
    });
    expect(byName.Fun).toMatchObject({ amount: 0, change: -10, changePct: -1 });
    expect(byName.Salary).toMatchObject({ side: "income", change: 500 });
    expect(chf.changes.map((c) => c.name)).toEqual([
      "Salary",
      "Travel",
      "Food",
      "New",
      "Fun",
    ]);
  });

  it("keeps currencies apart", async () => {
    const { tx, user } = await setup();
    const eur = seedAccount(user.id, { name: "Euro", currency: "EUR" });
    tx(-100, "2025-04-01");
    seedImportedTransaction(user.id, eur.id, {
      amount: m(-70),
      currency: "EUR",
      bookingDate: "2025-04-01",
    });
    seedImportedTransaction(user.id, eur.id, {
      amount: m(900),
      currency: "EUR",
      bookingDate: "2025-04-02",
    });
    const r = yearReview(user.id, { year: 2025, today: TODAY });
    expect(r.currencies.map((c) => [c.currency, c.income, c.expenses])).toEqual(
      [
        ["CHF", 0, 100],
        ["EUR", 900, 70],
      ],
    );
    expect(r.currencies[0]!.savingsRate).toBeNull();
  });

  it("excludes transfers between own accounts and counts them", async () => {
    const { user, tx } = await setup();
    const savings = seedAccount(user.id, {
      name: "Savings",
      iban: EXAMPLE_IBAN_OTHER,
    });
    const checking = seedAccount(user.id, {
      name: "Checking",
      iban: EXAMPLE_IBAN,
    });
    seedImportedTransaction(user.id, checking.id, {
      amount: m(-500),
      bookingDate: "2025-06-01",
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    seedImportedTransaction(user.id, savings.id, {
      amount: m(500),
      bookingDate: "2025-06-01",
      counterpartyIban: IBAN_CH_SPACED,
    });
    tx(-20, "2025-06-02", { counterpartyIban: IBAN_DE });
    const r = yearReview(user.id, { year: 2025, today: TODAY });
    expect(r.excludedTransfers).toBe(2);
    expect(r.currencies[0]).toMatchObject({ income: 0, expenses: 20 });
  });

  it("ranks counterparties and the largest transactions", async () => {
    const { tx, user, cat } = await setup();
    const food = cat("Food");
    tx(-30, "2025-01-01", { counterpartyName: "Shop A", categoryId: food.id });
    tx(-40, "2025-02-01", { counterpartyName: "shop a " });
    tx(-60, "2025-03-01", { counterpartyName: "Shop B" });
    tx(15, "2025-03-02", { counterpartyName: "Shop B" });
    tx(-5, "2025-03-03");
    tx(2000, "2025-03-04", { counterpartyName: "Employer" });
    const chf = yearReview(user.id, { year: 2025, today: TODAY })
      .currencies[0]!;
    expect(chf.counterparties).toEqual([
      { name: "Shop A", spent: 70, count: 2 },
      { name: "Shop B", spent: 60, count: 1 },
    ]);
    expect(chf.largestExpenses.map((t) => t.amount)).toEqual([
      -60, -40, -30, -5,
    ]);
    expect(chf.largestExpenses[2]!.categoryName).toBe("Food");
    expect(chf.largestIncome.map((t) => [t.amount, t.counterparty])).toEqual([
      [2000, "Employer"],
      [15, "Shop B"],
    ]);
  });

  it("measures net worth change from the end of the previous year", async () => {
    const { tx, user } = await setup();
    tx(-1000, "2024-12-30");
    tx(3000, "2025-03-01");
    tx(-500, "2025-07-01");
    const chf = yearReview(user.id, { year: 2025, today: TODAY })
      .currencies[0]!;
    expect(chf.netWorth).toEqual({ start: 99000, end: 101500, change: 2500 });
  });

  it("covers the current year up to today", async () => {
    const { tx, user } = await setup();
    tx(-10, "2026-03-01");
    tx(-20, "2026-12-01");
    const r = yearReview(user.id, { year: 2026, today: TODAY });
    expect(r.partial).toBe(true);
    expect(r.to).toBe(TODAY);
    expect(r.currencies[0]!.expenses).toBe(10);
  });

  it("only sees the given user's data and ignores archived accounts", async () => {
    const { tx, user } = await setup();
    const other = await createTestUser();
    seedImportedTransaction(other.id, seedAccount(other.id).id, {
      amount: m(-777),
      bookingDate: "2025-01-01",
    });
    const archived = seedAccount(user.id, { name: "Old" });
    seedImportedTransaction(user.id, archived.id, {
      amount: m(-555),
      bookingDate: "2025-01-01",
    });
    setAccountArchived(user.id, archived.id, true);
    tx(-10, "2025-01-01");
    const r = yearReview(user.id, { year: 2025, today: TODAY });
    expect(r.currencies[0]!.expenses).toBe(10);
  });
});
