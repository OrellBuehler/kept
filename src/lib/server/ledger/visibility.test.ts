import { describe, expect, it } from "vitest";
import { buildWorld } from "$lib/testing/mcp-world";
import { useTestDB } from "$lib/testing/db";
import { LedgerError } from "./errors";
import {
  UNRESTRICTED,
  accountAllowed,
  assertTransactionVisible,
  categoryAllowed,
  isRestricted,
  transactionVisibility,
  visibleTransactionIds,
} from "./visibility";

describe("visibility", () => {
  useTestDB();

  it("is unrestricted by default and builds no filter then", () => {
    expect(isRestricted(UNRESTRICTED)).toBe(false);
    expect(transactionVisibility(UNRESTRICTED)).toBeUndefined();
    expect(transactionVisibility(undefined)).toBeUndefined();
    expect(accountAllowed(UNRESTRICTED, "x")).toBe(true);
    expect(categoryAllowed(UNRESTRICTED, null)).toBe(true);
  });

  it("a category restriction hides uncategorized payments, an account restriction other accounts", () => {
    const cat = { categoryIds: ["c"], accountIds: null };
    expect(categoryAllowed(cat, "c")).toBe(true);
    expect(categoryAllowed(cat, "d")).toBe(false);
    expect(categoryAllowed(cat, null)).toBe(false);
    const acc = { categoryIds: null, accountIds: ["a"] };
    expect(accountAllowed(acc, "a")).toBe(true);
    expect(accountAllowed(acc, "b")).toBe(false);
    expect(isRestricted(acc)).toBe(true);
  });

  it("selects the visible ones among the user's own payments", async () => {
    const w = await buildWorld();
    const all = [w.t1, w.t2, w.t3, w.t4, w.t5, w.bTx].map((t) => t.id);
    expect(
      [...(await visibleTransactionIds(w.a.id, UNRESTRICTED, all))].sort(),
    ).toEqual([w.t1, w.t2, w.t3, w.t4, w.t5].map((t) => t.id).sort());
    expect(
      [
        ...(await visibleTransactionIds(
          w.a.id,
          { accountIds: [w.savings.id], categoryIds: null },
          all,
        )),
      ].sort(),
    ).toEqual([w.t3.id, w.t4.id].sort());
    expect(
      [
        ...(await visibleTransactionIds(
          w.a.id,
          { accountIds: null, categoryIds: [w.food.id] },
          all,
        )),
      ].sort(),
    ).toEqual([w.t1.id, w.t3.id].sort());
    expect([
      ...(await visibleTransactionIds(
        w.a.id,
        { accountIds: [], categoryIds: null },
        all,
      )),
    ]).toEqual([]);
    expect(await visibleTransactionIds(w.a.id, UNRESTRICTED, [])).toEqual(
      new Set(),
    );
  });

  it("answers not found for another user's payment and for one outside the restriction", async () => {
    const w = await buildWorld();
    await expect(
      assertTransactionVisible(w.a.id, UNRESTRICTED, w.bTx.id),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      assertTransactionVisible(
        w.a.id,
        { accountIds: [w.checking.id], categoryIds: null },
        w.t3.id,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      assertTransactionVisible(
        w.a.id,
        { accountIds: [w.checking.id], categoryIds: null },
        w.t1.id,
      ),
    ).resolves.toBeUndefined();
  });
});
