import { describe, expect, it } from "vitest";
import { listCategories } from "$lib/server/categories/categories";
import { createCategory } from "$lib/server/categories/categories";
import { createRule, loadRules } from "$lib/server/categories/rules";
import { listTransactions } from "$lib/server/ledger/transactions";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
const run = (
  name: keyof typeof actions,
  user: User,
  form: Record<string, string>,
) => outcome(() => actions[name](createTestEvent({ user, form }) as never));

const plain = {
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
};

describe("settings/categories page", () => {
  useTestDB();

  it("load returns only the current user's categories and rules", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = createCategory(a.id, { name: "Mine", ...plain });
    const theirs = createCategory(b.id, { name: "Theirs", ...plain });
    createRule(a.id, {
      categoryId: mine.id,
      priority: 100,
      counterpartyContains: "x",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    createRule(b.id, {
      categoryId: theirs.id,
      priority: 100,
      counterpartyContains: "y",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    const r = await outcome(() => load(createTestEvent({ user: a }) as never));
    const v = (
      r as { value: { categories: { name: string }[]; rules: unknown[] } }
    ).value;
    expect(v.categories.map((c) => c.name)).toEqual(["Mine"]);
    expect(v.rules).toHaveLength(1);
  });

  it("creates, updates and deletes a category", async () => {
    const u = await createTestUser();
    const created = await run("createCategory", u, {
      name: "Food",
      kind: "expense",
      parentId: "",
      color: "#2563eb",
      icon: "utensils",
    });
    expect(created).toMatchObject({
      type: "return",
      value: { success: true, action: "createCategory" },
    });
    const [food] = listCategories(u.id);
    expect(food).toMatchObject({ name: "Food", color: "#2563eb" });

    await run("updateCategory", u, {
      id: food!.id,
      name: "Groceries",
      kind: "expense",
      parentId: "",
      color: "",
      icon: "",
    });
    expect(listCategories(u.id)[0]).toMatchObject({
      name: "Groceries",
      color: null,
    });

    await run("deleteCategory", u, { id: food!.id });
    expect(listCategories(u.id)).toEqual([]);
  });

  it("answers field errors with 400 and nothing is written", async () => {
    const u = await createTestUser();
    const r = await run("createCategory", u, {
      name: "",
      kind: "expense",
      color: "red",
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { name: expect.any(Array), color: expect.any(Array) } },
    });
    expect(listCategories(u.id)).toEqual([]);
  });

  it("requires a condition on a rule", async () => {
    const u = await createTestUser();
    const c = createCategory(u.id, { name: "C", ...plain });
    const r = await run("createRule", u, { categoryId: c.id, priority: "" });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { form: ["Set at least one condition."] } },
    });
    expect(loadRules(u.id)).toEqual([]);
  });

  it("another user's ids answer 404 and change nothing", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = createCategory(a.id, { name: "Mine", ...plain });
    const rule = createRule(a.id, {
      categoryId: mine.id,
      priority: 100,
      counterpartyContains: "x",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    expect(await run("deleteCategory", b, { id: mine.id })).toEqual({
      type: "error",
      status: 404,
    });
    expect(await run("deleteRule", b, { id: rule.id })).toEqual({
      type: "error",
      status: 404,
    });
    expect(
      await run("updateCategory", b, {
        id: mine.id,
        name: "Hijacked",
        kind: "expense",
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await run("createRule", b, {
        categoryId: mine.id,
        counterpartyContains: "x",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(listCategories(a.id)[0]!.name).toBe("Mine");
    expect(loadRules(a.id)).toHaveLength(1);
    expect(loadRules(b.id)).toEqual([]);
  });

  it("applies rules to uncategorized transactions of the user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accA = seedAccount(a.id);
    const accB = seedAccount(b.id);
    seedImportedTransaction(a.id, accA.id, {
      counterpartyName: "Example Shop",
    });
    seedImportedTransaction(b.id, accB.id, {
      counterpartyName: "Example Shop",
    });
    const c = createCategory(a.id, { name: "Shopping", ...plain });
    createRule(a.id, {
      categoryId: c.id,
      priority: 100,
      counterpartyContains: "shop",
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: null,
    });
    const r = await run("applyRules", a, {});
    expect(r).toMatchObject({
      type: "return",
      value: { success: true, scanned: 1, categorized: 1 },
    });
    expect(listTransactions(a.id, accA.id).items[0]!.categoryId).toBe(c.id);
    expect(listTransactions(b.id, accB.id).items[0]!.categoryId).toBeNull();
  });
});
