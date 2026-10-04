import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { first, getDB, transactions } from "$lib/server/db";
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
    const food = await createCategory(u.id, cat("Food"));
    const groceries = await createCategory(
      u.id,
      cat("Groceries", { parentId: food.id }),
    );
    await createCategory(u.id, cat("Salary", { kind: "income" }));
    expect((await listCategories(u.id)).map((c) => c.name)).toEqual([
      "Food",
      "Groceries",
      "Salary",
    ]);
    await updateCategory(
      u.id,
      groceries.id,
      cat("Supermarket", { parentId: food.id }),
    );
    expect((await getCategory(u.id, groceries.id)).name).toBe("Supermarket");
    await deleteCategory(u.id, food.id);
    expect((await getCategory(u.id, groceries.id)).parentId).toBeNull();
  });

  it("rejects duplicate names, deep nesting, self parents and kind clashes", async () => {
    const u = await createTestUser();
    const a = await createCategory(u.id, cat("A"));
    const b = await createCategory(u.id, cat("B", { parentId: a.id }));
    const expectInvalid = async (fn: () => unknown, field: string) => {
      try {
        await fn();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(LedgerError);
        expect((err as LedgerError).field).toBe(field);
      }
    };
    await expectInvalid(() => createCategory(u.id, cat("A")), "name");
    await expectInvalid(
      () => createCategory(u.id, cat("C", { parentId: b.id })),
      "parentId",
    );
    await expectInvalid(
      () => updateCategory(u.id, a.id, cat("A", { parentId: a.id })),
      "parentId",
    );
    await expectInvalid(
      () => createCategory(u.id, cat("D", { parentId: a.id, kind: "income" })),
      "kind",
    );
    await expectInvalid(
      () => updateCategory(u.id, a.id, cat("A", { kind: "income" })),
      "kind",
    );
    const other = await createCategory(u.id, cat("Other"));
    await expectInvalid(
      () => updateCategory(u.id, a.id, cat("A", { parentId: other.id })),
      "parentId",
    );
  });

  it("is scoped to the user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = await createCategory(a.id, cat("Mine"));
    await createCategory(b.id, cat("Mine"));
    expect(await listCategories(a.id)).toHaveLength(1);
    await expect(getCategory(b.id, mine.id)).rejects.toThrow(/not found/i);
    await expect(deleteCategory(b.id, mine.id)).rejects.toThrow(/not found/i);
    await expect(updateCategory(b.id, mine.id, cat("X"))).rejects.toThrow(
      /not found/i,
    );
    await expect(
      createCategory(b.id, cat("Child", { parentId: mine.id })),
    ).rejects.toThrow(/valid parent/i);
  });

  it("assigns and clears a transaction's category, only with own rows", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const tx = await seedImportedTransaction(a.id, acc.id);
    const mine = await createCategory(a.id, cat("Mine"));
    const theirs = await createCategory(b.id, cat("Theirs"));

    await assignCategory(a.id, tx.id, mine.id);
    expect((await listTransactions(a.id, acc.id)).items[0]!.categoryId).toBe(
      mine.id,
    );
    await assignCategory(a.id, tx.id, null);
    expect(
      (await listTransactions(a.id, acc.id)).items[0]!.categoryId,
    ).toBeNull();

    await expect(assignCategory(b.id, tx.id, theirs.id)).rejects.toThrow(
      /not found/i,
    );
    await expect(assignCategory(a.id, tx.id, theirs.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("uncategorizes transactions when their category is deleted", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const c = await createCategory(u.id, cat("Gone"));
    const tx = await seedImportedTransaction(u.id, acc.id, {
      categoryId: c.id,
    });
    await deleteCategory(u.id, c.id);
    const row = (await first(
      getDB()
        .select()
        .from(transactions)
        .where(eq(transactions.id, tx.id))
        .limit(1),
    ))!;
    expect(row.categoryId).toBeNull();
  });
});

describe("rules", () => {
  it("applies in priority order, then creation order", async () => {
    const u = await createTestUser();
    const a = await createCategory(u.id, cat("A"));
    const b = await createCategory(u.id, cat("B"));
    await createRule(
      u.id,
      rule(a.id, { priority: 50, descriptionContains: "x" }),
    );
    await createRule(
      u.id,
      rule(b.id, { priority: 10, descriptionContains: "x" }),
    );
    await createRule(
      u.id,
      rule(a.id, { priority: 10, descriptionContains: "y" }),
    );
    expect(
      (await loadRules(u.id)).map((r) => [r.categoryId, r.priority]),
    ).toEqual([
      [b.id, 10],
      [a.id, 10],
      [a.id, 50],
    ]);
    expect((await listRules(u.id))[0]!.categoryName).toBe("B");
  });

  it("normalizes the IBAN, updates and deletes", async () => {
    const u = await createTestUser();
    const a = await createCategory(u.id, cat("A"));
    const r = await createRule(
      u.id,
      rule(a.id, { counterpartyIban: EXAMPLE_IBAN.toLowerCase() }),
    );
    expect(r.counterpartyIban).toBe(EXAMPLE_IBAN);
    const updated = await updateRule(
      u.id,
      r.id,
      rule(a.id, { amountSign: "income", priority: 5 }),
    );
    expect(updated).toMatchObject({
      amountSign: "income",
      priority: 5,
      counterpartyIban: null,
    });
    await deleteRule(u.id, r.id);
    expect(await loadRules(u.id)).toEqual([]);
  });

  it("rejects another user's category and foreign rules", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const theirs = await createCategory(b.id, cat("Theirs"));
    await expect(
      createRule(a.id, rule(theirs.id, { descriptionContains: "x" })),
    ).rejects.toThrow(/choose a category/i);
    const mine = await createCategory(a.id, cat("Mine"));
    const r = await createRule(
      a.id,
      rule(mine.id, { descriptionContains: "x" }),
    );
    await expect(deleteRule(b.id, r.id)).rejects.toThrow(/not found/i);
    await expect(
      updateRule(b.id, r.id, rule(theirs.id, { descriptionContains: "x" })),
    ).rejects.toThrow(/not found/i);
    expect(await loadRules(b.id)).toEqual([]);
  });

  it("re-runs on uncategorized transactions and never overrides a manual choice", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const food = await createCategory(u.id, cat("Food"));
    const manual = await createCategory(u.id, cat("Manual"));
    await createRule(u.id, rule(food.id, { counterpartyContains: "grocer" }));

    const open = await seedImportedTransaction(u.id, acc.id, {
      counterpartyName: "Example Grocer",
    });
    const chosen = await seedImportedTransaction(u.id, acc.id, {
      counterpartyName: "Example Grocer",
    });
    const unrelated = await seedImportedTransaction(u.id, acc.id, {
      counterpartyName: "Somebody",
    });
    await assignCategory(u.id, chosen.id, manual.id);

    expect(await applyRulesToUncategorized(u.id)).toEqual({
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
    expect(await applyRulesToUncategorized(u.id)).toEqual({
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
    const food = await createCategory(a.id, cat("Food"));
    await createRule(a.id, rule(food.id, { counterpartyContains: "grocer" }));
    expect(await applyRulesToUncategorized(a.id)).toEqual({
      scanned: 0,
      categorized: 0,
    });
    expect(
      (await listTransactions(b.id, accB.id)).items[0]!.categoryId,
    ).toBeNull();
    expect(tx.categoryId).toBeNull();
  });
});

describe("category writes check and write in one transaction", () => {
  it("changes nothing when an update is refused", async () => {
    const u = await createTestUser();
    const parent = await createCategory(u.id, cat("Parent"));
    const child = await createCategory(u.id, cat("Child"));
    await expect(
      updateCategory(
        u.id,
        child.id,
        cat("Renamed", { parentId: parent.id, kind: "income" }),
      ),
    ).rejects.toMatchObject({ field: "kind" });
    expect(await getCategory(u.id, child.id)).toMatchObject({
      name: "Child",
      parentId: null,
      kind: "expense",
    });
  });

  it("creates nothing when the name is taken, per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await createCategory(a.id, cat("Food"));
    await expect(createCategory(a.id, cat("Food"))).rejects.toMatchObject({
      code: "conflict",
      field: "name",
    });
    expect(await listCategories(a.id)).toHaveLength(1);
    await expect(createCategory(b.id, cat("Food"))).resolves.toMatchObject({
      name: "Food",
    });
  });

  it("lets a category keep its own name and answers 404 for another user's", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const food = await createCategory(a.id, cat("Food"));
    await expect(
      updateCategory(a.id, food.id, cat("Food", { color: "#112233" })),
    ).resolves.toMatchObject({ name: "Food", color: "#112233" });
    await expect(
      updateCategory(b.id, food.id, cat("Other", { parentId: "missing" })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await getCategory(a.id, food.id)).name).toBe("Food");
  });

  it("assigns nothing when the category is another user's", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const tx = await seedImportedTransaction(a.id, acc.id);
    const theirs = await createCategory(b.id, cat("Theirs"));
    await expect(assignCategory(a.id, tx.id, theirs.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await listTransactions(a.id, acc.id)).items[0]!.categoryId,
    ).toBeNull();
  });

  it("creates and updates rules only against the user's own categories", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = await createCategory(a.id, cat("Mine"));
    const theirs = await createCategory(b.id, cat("Theirs"));
    const created = await createRule(
      a.id,
      rule(mine.id, { counterpartyContains: "x" }),
    );
    await expect(
      createRule(a.id, rule(theirs.id, { counterpartyContains: "x" })),
    ).rejects.toMatchObject({ code: "invalid", field: "categoryId" });
    await expect(
      updateRule(
        a.id,
        created.id,
        rule(theirs.id, { counterpartyContains: "x" }),
      ),
    ).rejects.toMatchObject({ code: "invalid", field: "categoryId" });
    await expect(
      updateRule(
        b.id,
        created.id,
        rule(theirs.id, { counterpartyContains: "x" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await listRules(a.id)).toHaveLength(1);
    expect((await listRules(a.id))[0]!.categoryId).toBe(mine.id);
  });
});
