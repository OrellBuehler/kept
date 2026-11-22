/**
 * Long id lists in a change: listings show their count, `getChange` has them
 * whole, and past a hard cap an entry keeps only the count and cannot be
 * reverted. The cap is lowered here so the tests do not need ten thousand rows.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  applyRulesToUncategorized,
  createRule,
} from "$lib/server/categories/rules";
import {
  assignCategory,
  createCategory,
  deleteCategory,
} from "$lib/server/categories/categories";
import { getChange, listChanges } from "./list";
import { isRevertible, revertChange, whyNotRevertible } from "./revert";
import { LIST_ARRAY_LIMIT, isTruncatedList } from "./types";

vi.mock("./types", async (original) => ({
  ...(await original<typeof import("./types")>()),
  MAX_REVERTIBLE_IDS: 30,
}));
vi.mock("$lib/server/audit/types", async (original) => ({
  ...(await original<typeof import("./types")>()),
  MAX_REVERTIBLE_IDS: 30,
}));

useTestDB();

const cat = (name: string) => ({
  name,
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
});

async function world(payments: number) {
  const u = await createTestUser();
  const account = await seedAccount(u.id);
  const food = await createCategory(u.id, cat("Food"));
  const ids: string[] = [];
  for (let i = 0; i < payments; i++) {
    ids.push(
      (
        await seedImportedTransaction(u.id, account.id, {
          counterpartyName: "Example Grocer",
        })
      ).id,
    );
  }
  return { u, food, ids };
}

const newest = async (userId: string) =>
  (await listChanges(userId, { limit: 1 })).items[0]!;

describe("bounded listings", () => {
  it("shows a long id list of a category delete as a count, and getChange has it whole", async () => {
    const { u, food, ids } = await world(LIST_ARRAY_LIMIT + 5);
    for (const id of ids) await assignCategory(u.id, id, food.id);
    await deleteCategory(u.id, food.id);
    const listed = await newest(u.id);
    expect(listed.before!.transactionIds).toEqual({
      count: LIST_ARRAY_LIMIT + 5,
      truncated: true,
    });
    expect(isTruncatedList(listed.before!.transactionIds)).toBe(true);
    expect(listed.before!.childIds).toEqual([]);
    const full = await getChange(u.id, listed.id);
    expect(full.before!.transactionIds).toHaveLength(LIST_ARRAY_LIMIT + 5);
    expect(isRevertible(full)).toBe(true);
    // The revert reads the stored list, not the listing's.
    await revertChange(u.id, listed.id);
  });

  it("shows a long rule run as counts per category and keeps short lists as they are", async () => {
    const { u, food } = await world(LIST_ARRAY_LIMIT + 1);
    const other = await createCategory(u.id, cat("Other"));
    const account = await seedAccount(u.id);
    await seedImportedTransaction(u.id, account.id, {
      counterpartyName: "Example Baker",
    });
    await createRule(u.id, {
      categoryId: food.id,
      priority: 1,
      counterpartyContains: "grocer",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    await createRule(u.id, {
      categoryId: other.id,
      priority: 2,
      counterpartyContains: "baker",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    await applyRulesToUncategorized(u.id);
    const listed = await newest(u.id);
    expect(listed.after).toMatchObject({
      categorized: LIST_ARRAY_LIMIT + 2,
      byCategory: {
        [food.id]: { count: LIST_ARRAY_LIMIT + 1, truncated: true },
        [other.id]: [expect.any(String)],
      },
    });
    const full = await getChange(u.id, listed.id);
    expect(
      (full.after!.byCategory as Record<string, string[]>)[food.id],
    ).toHaveLength(LIST_ARRAY_LIMIT + 1);
    await revertChange(u.id, listed.id);
  });
});

describe("the cap on what one entry stores", () => {
  it("a rule run above the cap stores a count and cannot be reverted", async () => {
    const { u, food } = await world(31);
    await createRule(u.id, {
      categoryId: food.id,
      priority: 1,
      counterpartyContains: "grocer",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    await applyRulesToUncategorized(u.id);
    const entry = await getChange(u.id, (await newest(u.id)).id);
    expect(entry.after).toEqual({ categorized: 31, tooLarge: true });
    expect(isRevertible(entry)).toBe(false);
    expect(whyNotRevertible(entry)).toMatch(/too many payments/);
    await expect(revertChange(u.id, entry.id)).rejects.toMatchObject({
      reason: "not_revertible",
    });
  });

  it("a rule run at the cap is still revertible", async () => {
    const { u, food } = await world(30);
    await createRule(u.id, {
      categoryId: food.id,
      priority: 1,
      counterpartyContains: "grocer",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    await applyRulesToUncategorized(u.id);
    const entry = await newest(u.id);
    expect(isRevertible(entry)).toBe(true);
    await revertChange(u.id, entry.id);
  });

  it("a category delete above the cap stores a count and cannot be reverted", async () => {
    const { u, food, ids } = await world(31);
    for (const id of ids) await assignCategory(u.id, id, food.id);
    await deleteCategory(u.id, food.id);
    const entry = await getChange(u.id, (await newest(u.id)).id);
    expect(entry.before).toMatchObject({
      name: "Food",
      transactionCount: 31,
      tooLarge: true,
    });
    expect(entry.before).not.toHaveProperty("transactionIds");
    expect(isRevertible(entry)).toBe(false);
    expect(whyNotRevertible(entry)).toMatch(/too many payments/);
  });
});
