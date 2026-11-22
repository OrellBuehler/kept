/**
 * The tree rules (one level, same kind as the parent) read other categories, so
 * changes take a per-user lock; otherwise two overlapping moves could each pass
 * them on PostgreSQL.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { categories, getDB } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { setCategoryDeduction } from "$lib/server/tax/deductions";
import { createBudget, updateBudget } from "./budgets";
import {
  assignCategory,
  createCategory,
  deleteCategory,
  updateCategory,
} from "./categories";
import { createRule, deleteRule, updateRule } from "./rules";

useTestDB();
const category = (name: string, parentId: string | null = null) => ({
  name,
  kind: "expense" as const,
  parentId,
  color: null,
  icon: null,
});

describe("categories", () => {
  it("create, update and delete take the user's category lock", async () => {
    const user = await createTestUser();
    const key = `categories:${user.id}`;
    await expectHeldBy(key, () => createCategory(user.id, category("Food")));
    const food = await createCategory(user.id, category("Meals"));
    await expectHeldBy(key, () =>
      updateCategory(user.id, food.id, category("Dining")),
    );
    await expectHeldBy(key, () => deleteCategory(user.id, food.id));
  });

  it("everything that points at a category takes the same lock, so a delete or revert sees all of it", async () => {
    const user = await createTestUser();
    const key = `categories:${user.id}`;
    const food = await createCategory(user.id, category("Food"));
    const account = await seedAccount(user.id);
    const payment = await seedImportedTransaction(user.id, account.id);
    const rule = {
      categoryId: food.id,
      priority: 100,
      counterpartyContains: "grocer",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    };
    const made = { id: "" };
    await expectHeldBy(key, async () => {
      made.id = (await createRule(user.id, rule)).id;
    });
    await expectHeldBy(key, () =>
      updateRule(user.id, made.id, { ...rule, priority: 5 }),
    );
    await expectHeldBy(key, () => deleteRule(user.id, made.id));
    const budget = {
      categoryId: food.id,
      currency: "CHF",
      amount: minor(1000),
    };
    const budgetId = { id: "" };
    await expectHeldBy(key, async () => {
      budgetId.id = (await createBudget(user.id, budget)).id;
    });
    await expectHeldBy(key, () =>
      updateBudget(user.id, budgetId.id, { ...budget, amount: minor(2000) }),
    );
    await expectHeldBy(key, () => assignCategory(user.id, payment.id, food.id));
    await expectHeldBy(key, () =>
      setCategoryDeduction(user.id, food.id, "donations"),
    );
  });

  it("never nests more than one level when two moves overlap", async () => {
    for (let round = 0; round < 8; round++) {
      const user = await createTestUser();
      const a = await createCategory(user.id, category("A"));
      const b = await createCategory(user.id, category("B"));
      const c = await createCategory(user.id, category("C"));
      // A under B while B goes under C: either alone is fine, both are not.
      await Promise.allSettled([
        updateCategory(user.id, a.id, category("A", b.id)),
        updateCategory(user.id, b.id, category("B", c.id)),
      ]);
      const parents = new Map(
        (
          await getDB()
            .select()
            .from(categories)
            .where(eq(categories.userId, user.id))
        ).map((r) => [r.id, r.parentId]),
      );
      for (const [, parent] of parents) {
        if (parent !== null) expect(parents.get(parent)).toBeNull();
      }
    }
  });
});
