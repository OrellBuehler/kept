import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { createBudget, listBudgets } from "$lib/server/categories/budgets";
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

const expense = {
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
};

describe("budgets page", () => {
  useTestDB();

  it("load reports the requested month for the current user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accA = await seedAccount(a.id);
    const accB = await seedAccount(b.id, { currency: "EUR" });
    const food = await createCategory(a.id, { name: "Food", ...expense });
    await createBudget(a.id, {
      categoryId: food.id,
      currency: "CHF",
      amount: minor(10000),
    });
    await seedImportedTransaction(a.id, accA.id, {
      categoryId: food.id,
      amount: minor(-2500),
      bookingDate: "2026-03-10",
    });
    await seedImportedTransaction(b.id, accB.id, {
      amount: minor(-9999),
      bookingDate: "2026-03-10",
      currency: "EUR",
    });

    const r = await outcome(() =>
      load(
        createTestEvent({
          user: a,
          url: "http://localhost/budgets?month=2026-03",
        }) as never,
      ),
    );
    const v = (
      r as {
        value: {
          month: string;
          previousMonth: string;
          nextMonth: string;
          currencies: string[];
          report: { currencies: { currency: string; rows: unknown[] }[] };
        };
      }
    ).value;
    expect(v).toMatchObject({
      month: "2026-03",
      previousMonth: "2026-02",
      nextMonth: "2026-04",
      currencies: ["CHF"],
    });
    expect(v.report.currencies).toHaveLength(1);
    expect(v.report.currencies[0]).toMatchObject({
      currency: "CHF",
      rows: [{ categoryName: "Food", spent: 2500, budget: 10000 }],
    });
  });

  it("falls back to the current month for a bad month", async () => {
    const u = await createTestUser();
    const r = await outcome(() =>
      load(
        createTestEvent({
          user: u,
          url: "http://localhost/budgets?month=2026-13",
        }) as never,
      ),
    );
    expect((r as { value: { month: string } }).value.month).toMatch(
      /^\d{4}-\d{2}$/,
    );
    expect((r as { value: { month: string } }).value.month).not.toBe("2026-13");
  });

  it("creates, updates and deletes a budget", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, { name: "Food", ...expense });
    expect(
      await run("createBudget", u, {
        categoryId: food.id,
        currency: "chf",
        amount: "400.50",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    const [b] = await listBudgets(u.id);
    expect(b).toMatchObject({ currency: "CHF", amount: 40050 });

    await run("updateBudget", u, {
      id: b!.id,
      categoryId: food.id,
      currency: "CHF",
      amount: "500",
    });
    expect((await listBudgets(u.id))[0]!.amount).toBe(50000);

    await run("deleteBudget", u, { id: b!.id });
    expect(await listBudgets(u.id)).toEqual([]);
  });

  it("rejects bad amounts and duplicates with field errors", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, { name: "Food", ...expense });
    expect(
      await run("createBudget", u, {
        categoryId: food.id,
        currency: "CHF",
        amount: "-1",
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { amount: expect.any(Array) } },
    });
    await run("createBudget", u, {
      categoryId: food.id,
      currency: "CHF",
      amount: "10",
    });
    expect(
      await run("createBudget", u, {
        categoryId: food.id,
        currency: "CHF",
        amount: "20",
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { categoryId: expect.any(Array) } },
    });
    expect(await listBudgets(u.id)).toHaveLength(1);
  });

  it("another user's budget and category are not reachable", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const food = await createCategory(a.id, { name: "Food", ...expense });
    const budget = await createBudget(a.id, {
      categoryId: food.id,
      currency: "CHF",
      amount: minor(1000),
    });
    expect(await run("deleteBudget", b, { id: budget.id })).toEqual({
      type: "error",
      status: 404,
    });
    expect(
      await run("updateBudget", b, {
        id: budget.id,
        categoryId: food.id,
        currency: "CHF",
        amount: "5",
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await run("createBudget", b, {
        categoryId: food.id,
        currency: "CHF",
        amount: "5",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(await listBudgets(a.id)).toHaveLength(1);
    expect(await listBudgets(b.id)).toEqual([]);
  });
});
