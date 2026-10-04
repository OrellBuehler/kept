import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { archiveAccount } from "$lib/server/ledger";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import { upsertFxRates } from "./prices";
import { investmentsOverview } from "./overview";
import { parseFixed } from "$lib/quantity";

useTestDB();

const TODAY = "2026-10-15";

describe("investmentsOverview", () => {
  it("is empty without trades", async () => {
    const user = await createTestUser();
    seedAccount(user.id, { type: "investment" });
    expect(investmentsOverview(user.id, TODAY)).toEqual({
      totals: [],
      securities: [],
    });
  });

  it("groups a security across accounts and totals per account currency", async () => {
    const user = await createTestUser();
    const a = seedAccount(user.id, { name: "A", currency: "CHF" });
    const b = seedAccount(user.id, { name: "B", currency: "CHF" });
    const c = seedAccount(user.id, { name: "C", currency: "EUR" });
    const etf = seedSecurity(user.id, { name: "Example ETF", currency: "CHF" });
    seedTrade(user.id, a.id, etf.id, {
      qty: "10",
      price: "100",
      amount: 100000,
    });
    seedTrade(user.id, b.id, etf.id, { qty: "5", price: "100", amount: 50000 });
    upsertFxRates(user.id, [
      {
        base: "CHF",
        quote: "EUR",
        date: "2026-10-14",
        rate: parseFixed("1.1"),
      },
    ]);
    seedTrade(user.id, c.id, etf.id, { qty: "2", price: "100", amount: 22000 });
    seedProviderPrice(user.id, etf.id, "2026-10-14", "120");

    const o = investmentsOverview(user.id, TODAY);
    expect(o.securities).toHaveLength(1);
    const g = o.securities[0]!;
    expect(g.quantity).toBe(parseFixed("17"));
    expect(g.price).toBe(parseFixed("120"));
    expect(g.positions.map((p) => p.accountName).sort()).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(g.totals.map((t) => [t.currency, t.value, t.cost, t.gain])).toEqual([
      ["CHF", minor(180000), minor(150000), minor(30000)],
      ["EUR", minor(26400), minor(22000), minor(4400)],
    ]);
    expect(o.totals).toEqual(g.totals);
  });

  it("skips archived accounts and other users", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(user.id);
    const etf = seedSecurity(user.id);
    seedTrade(user.id, a.id, etf.id, { amount: 100000 });
    const oa = seedAccount(other.id);
    const oetf = seedSecurity(other.id);
    seedTrade(other.id, oa.id, oetf.id, { amount: 5000 });
    expect(investmentsOverview(user.id, TODAY).securities).toHaveLength(1);
    archiveAccount(user.id, a.id);
    expect(investmentsOverview(user.id, TODAY).securities).toEqual([]);
    expect(investmentsOverview(other.id, TODAY).totals).toHaveLength(1);
  });
});
