import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDB, transactions } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { listTransactions } from "$lib/server/ledger/transactions";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  assignCategory,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "./categories";
import {
  type CategoryRule,
  applyRulesToUncategorized,
  categorize,
  createRule,
  deleteRule,
  listRules,
  loadRules,
  ruleMatches,
  updateRule,
} from "./rules";
import {
  type CategoryInput,
  type RuleInput,
  categoryInputSchema,
  ruleInputSchema,
} from "./schemas";

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

const rule = (
  categoryId: string,
  over: Partial<RuleInput> = {},
): RuleInput => ({
  categoryId,
  priority: 100,
  counterpartyContains: null,
  descriptionContains: null,
  counterpartyIban: null,
  amountSign: null,
  ...over,
});

const subject = (
  over: Partial<Parameters<typeof ruleMatches>[1]> = {},
): Parameters<typeof ruleMatches>[1] => ({
  amount: -1000,
  counterpartyName: "Example Grocer Ltd",
  counterpartyIban: EXAMPLE_IBAN,
  description: "Weekly shopping",
  ...over,
});

const base: CategoryRule = {
  id: "r",
  categoryId: "c",
  priority: 100,
  counterpartyContains: null,
  descriptionContains: null,
  counterpartyIban: null,
  amountSign: null,
};

describe("rule matching", () => {
  it("matches counterparty and description text ignoring case", () => {
    expect(
      ruleMatches({ ...base, counterpartyContains: "GROCER" }, subject()),
    ).toBe(true);
    expect(
      ruleMatches({ ...base, descriptionContains: "weekly" }, subject()),
    ).toBe(true);
    expect(
      ruleMatches({ ...base, counterpartyContains: "bakery" }, subject()),
    ).toBe(false);
  });

  it("does not match text conditions against missing fields", () => {
    expect(
      ruleMatches(
        { ...base, counterpartyContains: "grocer" },
        subject({ counterpartyName: null }),
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        { ...base, descriptionContains: "weekly" },
        subject({ description: null }),
      ),
    ).toBe(false);
  });

  it("compares IBANs ignoring spaces and case", () => {
    const spaced = EXAMPLE_IBAN.replace(/(.{4})/g, "$1 ").toLowerCase();
    expect(ruleMatches({ ...base, counterpartyIban: spaced }, subject())).toBe(
      true,
    );
    expect(
      ruleMatches({ ...base, counterpartyIban: EXAMPLE_IBAN_OTHER }, subject()),
    ).toBe(false);
    expect(
      ruleMatches(
        { ...base, counterpartyIban: EXAMPLE_IBAN },
        subject({ counterpartyIban: null }),
      ),
    ).toBe(false);
  });

  it("matches the amount sign; zero is neither income nor expense", () => {
    const income = { ...base, amountSign: "income" as const };
    const expense = { ...base, amountSign: "expense" as const };
    expect(ruleMatches(income, subject({ amount: 500 }))).toBe(true);
    expect(ruleMatches(income, subject({ amount: -500 }))).toBe(false);
    expect(ruleMatches(expense, subject({ amount: -500 }))).toBe(true);
    expect(ruleMatches(expense, subject({ amount: 0 }))).toBe(false);
    expect(ruleMatches(income, subject({ amount: 0 }))).toBe(false);
  });

  it("requires every set condition", () => {
    const r = {
      ...base,
      counterpartyContains: "grocer",
      amountSign: "income" as const,
    };
    expect(ruleMatches(r, subject())).toBe(false);
    expect(ruleMatches(r, subject({ amount: 100 }))).toBe(true);
  });

  it("takes the first matching rule in order", () => {
    const rules: CategoryRule[] = [
      { ...base, id: "1", categoryId: "a", counterpartyContains: "bakery" },
      { ...base, id: "2", categoryId: "b", counterpartyContains: "grocer" },
      { ...base, id: "3", categoryId: "c", counterpartyContains: "example" },
    ];
    expect(categorize(rules, subject())).toBe("b");
    expect(
      categorize(rules, subject({ counterpartyName: "Other" })),
    ).toBeNull();
    expect(categorize([], subject())).toBeNull();
  });
});

describe("rule input", () => {
  it("requires at least one condition", () => {
    const r = ruleInputSchema.safeParse({ categoryId: "x", priority: "" });
    expect(r.success).toBe(false);
    const ok = ruleInputSchema.safeParse({
      categoryId: "x",
      priority: "",
      counterpartyContains: " grocer ",
    });
    expect(ok.success && ok.data).toMatchObject({
      priority: 100,
      counterpartyContains: "grocer",
      descriptionContains: null,
    });
  });

  it("validates colour and icon", () => {
    expect(
      categoryInputSchema.safeParse({
        name: "A",
        kind: "expense",
        color: "red",
      }).success,
    ).toBe(false);
    expect(
      categoryInputSchema.safeParse({
        name: "A",
        kind: "expense",
        icon: "nope",
      }).success,
    ).toBe(false);
    expect(
      categoryInputSchema.safeParse({
        name: "A",
        kind: "expense",
        color: "#aabbcc",
        icon: "house",
      }).success,
    ).toBe(true);
  });
});

describe("categories", () => {
  it("creates, lists as a tree, updates and deletes", async () => {
    const u = await createTestUser();
    const food = createCategory(u.id, cat("Food"));
    const groceries = createCategory(
      u.id,
      cat("Groceries", { parentId: food.id }),
    );
    createCategory(u.id, cat("Salary", { kind: "income" }));
    expect(listCategories(u.id).map((c) => c.name)).toEqual([
      "Food",
      "Groceries",
      "Salary",
    ]);
    updateCategory(
      u.id,
      groceries.id,
      cat("Supermarket", { parentId: food.id }),
    );
    expect(getCategory(u.id, groceries.id).name).toBe("Supermarket");
    deleteCategory(u.id, food.id);
    expect(getCategory(u.id, groceries.id).parentId).toBeNull();
  });

  it("rejects duplicate names, deep nesting, self parents and kind clashes", async () => {
    const u = await createTestUser();
    const a = createCategory(u.id, cat("A"));
    const b = createCategory(u.id, cat("B", { parentId: a.id }));
    const expectInvalid = (fn: () => unknown, field: string) => {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(LedgerError);
        expect((err as LedgerError).field).toBe(field);
      }
    };
    expectInvalid(() => createCategory(u.id, cat("A")), "name");
    expectInvalid(
      () => createCategory(u.id, cat("C", { parentId: b.id })),
      "parentId",
    );
    expectInvalid(
      () => updateCategory(u.id, a.id, cat("A", { parentId: a.id })),
      "parentId",
    );
    expectInvalid(
      () => createCategory(u.id, cat("D", { parentId: a.id, kind: "income" })),
      "kind",
    );
    expectInvalid(
      () => updateCategory(u.id, a.id, cat("A", { kind: "income" })),
      "kind",
    );
    const other = createCategory(u.id, cat("Other"));
    expectInvalid(
      () => updateCategory(u.id, a.id, cat("A", { parentId: other.id })),
      "parentId",
    );
  });

  it("is scoped to the user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = createCategory(a.id, cat("Mine"));
    createCategory(b.id, cat("Mine"));
    expect(listCategories(a.id)).toHaveLength(1);
    expect(() => getCategory(b.id, mine.id)).toThrow(/not found/i);
    expect(() => deleteCategory(b.id, mine.id)).toThrow(/not found/i);
    expect(() => updateCategory(b.id, mine.id, cat("X"))).toThrow(/not found/i);
    expect(() =>
      createCategory(b.id, cat("Child", { parentId: mine.id })),
    ).toThrow(/valid parent/i);
  });

  it("assigns and clears a transaction's category, only with own rows", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const tx = await seedImportedTransaction(a.id, acc.id);
    const mine = createCategory(a.id, cat("Mine"));
    const theirs = createCategory(b.id, cat("Theirs"));

    assignCategory(a.id, tx.id, mine.id);
    expect((await listTransactions(a.id, acc.id)).items[0]!.categoryId).toBe(
      mine.id,
    );
    assignCategory(a.id, tx.id, null);
    expect(
      (await listTransactions(a.id, acc.id)).items[0]!.categoryId,
    ).toBeNull();

    expect(() => assignCategory(b.id, tx.id, theirs.id)).toThrow(/not found/i);
    expect(() => assignCategory(a.id, tx.id, theirs.id)).toThrow(/not found/i);
  });

  it("uncategorizes transactions when their category is deleted", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const c = createCategory(u.id, cat("Gone"));
    const tx = await seedImportedTransaction(u.id, acc.id, {
      categoryId: c.id,
    });
    deleteCategory(u.id, c.id);
    const row = getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.id, tx.id))
      .get()!;
    expect(row.categoryId).toBeNull();
  });
});

describe("rules", () => {
  it("applies in priority order, then creation order", async () => {
    const u = await createTestUser();
    const a = createCategory(u.id, cat("A"));
    const b = createCategory(u.id, cat("B"));
    createRule(u.id, rule(a.id, { priority: 50, descriptionContains: "x" }));
    createRule(u.id, rule(b.id, { priority: 10, descriptionContains: "x" }));
    createRule(u.id, rule(a.id, { priority: 10, descriptionContains: "y" }));
    expect(loadRules(u.id).map((r) => [r.categoryId, r.priority])).toEqual([
      [b.id, 10],
      [a.id, 10],
      [a.id, 50],
    ]);
    expect(listRules(u.id)[0]!.categoryName).toBe("B");
  });

  it("normalizes the IBAN, updates and deletes", async () => {
    const u = await createTestUser();
    const a = createCategory(u.id, cat("A"));
    const r = createRule(
      u.id,
      rule(a.id, { counterpartyIban: EXAMPLE_IBAN.toLowerCase() }),
    );
    expect(r.counterpartyIban).toBe(EXAMPLE_IBAN);
    const updated = updateRule(
      u.id,
      r.id,
      rule(a.id, { amountSign: "income", priority: 5 }),
    );
    expect(updated).toMatchObject({
      amountSign: "income",
      priority: 5,
      counterpartyIban: null,
    });
    deleteRule(u.id, r.id);
    expect(loadRules(u.id)).toEqual([]);
  });

  it("rejects another user's category and foreign rules", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const theirs = createCategory(b.id, cat("Theirs"));
    expect(() =>
      createRule(a.id, rule(theirs.id, { descriptionContains: "x" })),
    ).toThrow(/choose a category/i);
    const mine = createCategory(a.id, cat("Mine"));
    const r = createRule(a.id, rule(mine.id, { descriptionContains: "x" }));
    expect(() => deleteRule(b.id, r.id)).toThrow(/not found/i);
    expect(() =>
      updateRule(b.id, r.id, rule(theirs.id, { descriptionContains: "x" })),
    ).toThrow(/not found/i);
    expect(loadRules(b.id)).toEqual([]);
  });

  it("re-runs on uncategorized transactions and never overrides a manual choice", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const food = createCategory(u.id, cat("Food"));
    const manual = createCategory(u.id, cat("Manual"));
    createRule(u.id, rule(food.id, { counterpartyContains: "grocer" }));

    const open = await seedImportedTransaction(u.id, acc.id, {
      counterpartyName: "Example Grocer",
    });
    const chosen = await seedImportedTransaction(u.id, acc.id, {
      counterpartyName: "Example Grocer",
    });
    const unrelated = await seedImportedTransaction(u.id, acc.id, {
      counterpartyName: "Somebody",
    });
    assignCategory(u.id, chosen.id, manual.id);

    expect(applyRulesToUncategorized(u.id)).toEqual({
      scanned: 2,
      categorized: 1,
    });
    const byId = new Map(
      (await listTransactions(u.id, acc.id)).items.map((t) => [
        t.id,
        t.categoryId,
      ]),
    );
    expect(byId.get(open.id)).toBe(food.id);
    expect(byId.get(chosen.id)).toBe(manual.id);
    expect(byId.get(unrelated.id)).toBeNull();
    expect(applyRulesToUncategorized(u.id)).toEqual({
      scanned: 1,
      categorized: 0,
    });
  });

  it("never touches another user's transactions", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accB = await seedAccount(b.id);
    const tx = await seedImportedTransaction(b.id, accB.id, {
      counterpartyName: "Example Grocer",
    });
    const food = createCategory(a.id, cat("Food"));
    createRule(a.id, rule(food.id, { counterpartyContains: "grocer" }));
    expect(applyRulesToUncategorized(a.id)).toEqual({
      scanned: 0,
      categorized: 0,
    });
    expect(
      (await listTransactions(b.id, accB.id)).items[0]!.categoryId,
    ).toBeNull();
    expect(tx.categoryId).toBeNull();
  });
});
