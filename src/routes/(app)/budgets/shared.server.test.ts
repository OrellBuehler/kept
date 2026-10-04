import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { load } from "./+page.server";

type Loaded = {
  basis: string;
  hasShared: boolean;
  report: { currencies: { unbudgeted: { spent: number }[] }[] };
};

async function loadBudgets(
  user: Awaited<ReturnType<typeof createTestUser>>,
  query: string,
) {
  const r = await outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://localhost/budgets?month=2026-03${query}`,
      }) as never,
    ),
  );
  return (r as { value: Loaded }).value;
}

describe("budgets page with shared accounts", () => {
  useTestDB();

  it("counts shared spending at the share by default and in full on request", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id, { shareBps: 5000 });
    const food = createCategory(u.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    seedImportedTransaction(u.id, acc.id, {
      categoryId: food.id,
      amount: minor(-2501),
      bookingDate: "2026-03-10",
    });

    const share = await loadBudgets(u, "");
    expect(share).toMatchObject({ basis: "share", hasShared: true });
    expect(share.report.currencies[0]!.unbudgeted[0]!.spent).toBe(1251);

    const total = await loadBudgets(u, "&basis=total");
    expect(total.basis).toBe("total");
    expect(total.report.currencies[0]!.unbudgeted[0]!.spent).toBe(2501);

    const bogus = await loadBudgets(u, "&basis=half");
    expect(bogus.basis).toBe("share");
  });

  it("reports no shared accounts for a plain user", async () => {
    const u = await createTestUser();
    seedAccount(u.id);
    expect((await loadBudgets(u, "")).hasShared).toBe(false);
  });
});
