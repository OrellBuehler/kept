import { afterEach, describe, expect, it } from "vitest";
import type { ApiScope } from "$lib/api-tokens";
import { minor } from "$lib/money";
import { allocate } from "$lib/server/bills/allocations";
import { createBudget } from "$lib/server/categories";
import { revokeApiToken } from "$lib/server/auth/api-tokens";
import { apiAuthFailureLimiter } from "$lib/server/external-api/gate";
import { createPlannedItem } from "$lib/server/forecast";
import {
  addTaxCredit,
  setTransactionTaxYear,
  upsertTaxYear,
} from "$lib/server/tax";
import {
  taxCreditInputSchema,
  taxYearInputSchema,
} from "$lib/server/tax/schemas";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedToken } from "$lib/testing/external-api";
import { seedSecurity, seedTrade } from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import { callTool, type ToolOutcome } from "$lib/testing/mcp";
import { buildWorld } from "$lib/testing/mcp-world";
import { seedPillar3aAccount, seedPortfolio } from "$lib/testing/pillar3a";
import { mcpTokenLimiter } from "./gate";
import { TOOLS } from "./tools/index";

afterEach(() => {
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

/**
 * The rule these tests encode: a tool returns data that belongs to another
 * scope only when the connection holds that scope too. Every kind of data has
 * the sentinel strings the seeded world uses for it and the scope that owns it.
 * Each tool is called with exactly the scopes it declares, and its answer must
 * not contain the sentinels of any kind its scopes do not own.
 */
type Kind = "payment" | "account" | "category" | "bill";

const OWNER: Record<Kind, ApiScope> = {
  payment: "transactions:read",
  account: "accounts:read",
  category: "categories:read",
  bill: "bills:read",
};

const SENTINELS: Record<Kind, string[]> = {
  payment: ["Shop One", "groceries one", "Shop Two", "Kiosk", "snacks", "Cafe"],
  account: ["Checking", "Savings", "Brokerage Z", "Retirement 3a"],
  category: ["Food", "Rent"],
  bill: ["Second Supplier", "Future Creditor", "Fresh Creditor"],
};

const KINDS = Object.keys(OWNER) as Kind[];

/** Kinds a tool's declared scopes do not own: none of their sentinels may appear. */
function hiddenKinds(scopes: readonly ApiScope[]): Kind[] {
  return KINDS.filter((k) => !scopes.includes(OWNER[k]));
}

function leaks(text: string, kinds: readonly Kind[]): string[] {
  return kinds.flatMap((k) => SENTINELS[k].filter((s) => text.includes(s)));
}

async function build() {
  const w = await buildWorld();
  const brokerage = await seedAccount(w.a.id, {
    name: "Brokerage Z",
    type: "investment",
  });
  const etf = await seedSecurity(w.a.id);
  await seedTrade(w.a.id, brokerage.id, etf.id, {
    qty: "10",
    amount: -100000,
  });
  const retirement = await seedPillar3aAccount(w.a.id);
  await seedPortfolio(w.a.id, retirement.id);

  const today = new Date();
  today.setUTCDate(today.getUTCDate() + 5);
  const future = await seedBill(w.a.id, {
    creditorName: "Future Creditor",
    amount: minor(4000),
    dueDate: today.toISOString().slice(0, 10),
  });
  const doomed = await seedBill(w.a.id, {
    creditorName: "Fresh Creditor",
    amount: minor(100),
  });
  await createBudget(w.a.id, {
    categoryId: w.food.id,
    currency: "CHF",
    amount: minor(10000),
  });
  await createPlannedItem(w.a.id, {
    accountId: w.checking.id,
    date: "2099-12-05",
    direction: "expense",
    amount: "20.00",
    currency: null,
    label: "Gift",
  });
  // A payment of Shop One on a bill, and a tax payment of Kiosk.
  const shopAllocation = await allocate(
    w.a.id,
    w.bill2.id,
    w.t1.id,
    minor(1250),
    "user",
  );
  const spare = await allocate(w.a.id, w.bill2.id, w.t5.id, minor(300), "user");
  await setTransactionTaxYear(w.a.id, w.t4.id, 2026);
  await upsertTaxYear(
    w.a.id,
    taxYearInputSchema.parse({
      year: "2026",
      authority: "Example Tax Office",
      currency: "CHF",
      assessedTotal: "",
      notes: "",
    }),
  );
  await addTaxCredit(
    w.a.id,
    2026,
    taxCreditInputSchema("CHF").parse({
      bookingDate: "2026-03-13",
      amount: "7.00",
      reference: "",
      description: "",
    }),
  );

  const full = await seedToken(
    w.a.id,
    ["categories:write", "categories:read"],
    { name: "setup" },
  );
  const rule = await callTool(full.token, "create_category_rule", {
    categoryId: w.food.id,
    counterpartyContains: "zzz",
  });
  const spareCategory = await callTool(full.token, "create_category", {
    name: "Spare",
    kind: "expense",
  });

  return {
    w,
    future,
    doomed,
    shopAllocation,
    spare,
    ruleId: rule.data.id as string,
    spareCategoryId: spareCategory.data.id as string,
  };
}

type World = Awaited<ReturnType<typeof build>>;

/** Arguments that make each tool do something real in the seeded world. */
const ARGS: Record<string, (x: World) => Record<string, unknown>> = {
  whoami: () => ({}),
  list_bills: () => ({}),
  get_bill: (x) => ({ billId: x.w.bill2.id }),
  create_bill: () => ({ creditorName: "Brand New Creditor", amount: "1.00" }),
  update_bill: (x) => ({ billId: x.w.bill2.id, notes: "n" }),
  set_bill_cancelled: (x) => ({ billId: x.future.id, cancelled: false }),
  delete_bill: (x) => ({ billId: x.doomed.id }),
  list_match_suggestions: () => ({}),
  list_payment_candidates: (x) => ({ billId: x.w.bill2.id }),
  allocate_payment: (x) => ({
    billId: x.w.bill2.id,
    paymentId: x.w.t3.id,
    amount: "1.00",
  }),
  remove_allocation: (x) => ({ allocationId: x.spare.id }),
  dismiss_suggestion: (x) => ({
    billId: x.w.bill2.id,
    paymentId: x.w.t4.id,
  }),
  run_auto_match: () => ({}),
  list_transactions: () => ({}),
  get_transaction: (x) => ({ paymentId: x.w.t1.id }),
  update_transaction: (x) => ({ paymentId: x.w.t1.id, note: "n" }),
  update_transactions: (x) => ({
    changes: [{ paymentId: x.w.t1.id, note: "n" }],
  }),
  list_accounts: () => ({}),
  get_balances: () => ({}),
  get_net_worth: () => ({}),
  list_categories: () => ({}),
  list_category_rules: () => ({}),
  create_category: () => ({ name: "Fresh Category", kind: "expense" }),
  update_category: (x) => ({ categoryId: x.w.food.id, color: "#112233" }),
  delete_category: (x) => ({ categoryId: x.spareCategoryId }),
  create_category_rule: (x) => ({
    categoryId: x.w.rent.id,
    counterpartyContains: "yyy",
  }),
  update_category_rule: (x) => ({ ruleId: x.ruleId, priority: 5 }),
  delete_category_rule: (x) => ({ ruleId: x.ruleId }),
  apply_category_rules: () => ({}),
  get_budgets: () => ({ month: "2026-03" }),
  list_recurring_payments: () => ({}),
  get_forecast: () => ({ days: 90 }),
  list_planned_items: () => ({}),
  get_investments: () => ({}),
  get_pillar3a: () => ({}),
  list_tax_years: () => ({}),
  get_tax_year: () => ({ year: 2026 }),
  // The change log tools are exercised below with a connection that made changes.
  list_changes: () => ({}),
  revert_change: () => ({}),
  revert_changes: () => ({}),
};

const CHANGE_LOG_TOOLS = new Set([
  "list_changes",
  "revert_change",
  "revert_changes",
]);

describe("mcp tools: a tool returns another scope's data only with that scope", () => {
  useTestDB();

  it("classifies every tool", () => {
    expect(Object.keys(ARGS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("answers each tool, called with only the scopes it declares, without data of the kinds those scopes do not own", async () => {
    const x = await build();
    const failures: string[] = [];
    for (const tool of TOOLS) {
      if (CHANGE_LOG_TOOLS.has(tool.name)) continue;
      const { token, info } = await seedToken(x.w.a.id, tool.scopes, {
        name: tool.name,
      });
      const r = await callTool(token, tool.name, ARGS[tool.name]!(x));
      await revokeApiToken(x.w.a.id, info.id);
      if (r.isError) failures.push(`${tool.name} failed: ${r.text}`);
      for (const s of leaks(r.text, hiddenKinds(tool.scopes))) {
        failures.push(`${tool.name} returned "${s}" without its scope`);
      }
    }
    expect(failures).toEqual([]);
  });

  describe("the extra scope unlocks exactly its own data", () => {
    const run = async (
      x: World,
      name: string,
      scopes: readonly ApiScope[],
    ): Promise<ToolOutcome> => {
      const { token } = await seedToken(x.w.a.id, scopes);
      const r = await callTool(token, name, ARGS[name]!(x));
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      return r;
    };

    const cases: {
      tool: string;
      scopes: ApiScope[];
      extra: ApiScope;
      sentinel: string;
    }[] = [
      {
        tool: "update_transaction",
        scopes: ["transactions:write"],
        extra: "transactions:read",
        sentinel: "Shop One",
      },
      {
        tool: "get_bill",
        scopes: ["bills:read"],
        extra: "transactions:read",
        sentinel: "Shop One",
      },
      {
        tool: "get_balances",
        scopes: ["balances:read"],
        extra: "accounts:read",
        sentinel: "Checking",
      },
      {
        tool: "get_budgets",
        scopes: ["budgets:read"],
        extra: "categories:read",
        sentinel: "Food",
      },
      {
        tool: "get_forecast",
        scopes: ["forecast:read"],
        extra: "accounts:read",
        sentinel: "Checking",
      },
      {
        tool: "get_forecast",
        scopes: ["forecast:read"],
        extra: "bills:read",
        sentinel: "Future Creditor",
      },
      {
        tool: "get_investments",
        scopes: ["investments:read"],
        extra: "accounts:read",
        sentinel: "Brokerage Z",
      },
      {
        tool: "get_pillar3a",
        scopes: ["pillar3a:read"],
        extra: "accounts:read",
        sentinel: "Retirement 3a",
      },
      {
        tool: "get_tax_year",
        scopes: ["taxes:read"],
        extra: "transactions:read",
        sentinel: "Kiosk",
      },
      {
        tool: "update_bill",
        scopes: ["bills:write"],
        extra: "bills:read",
        sentinel: "Second Supplier",
      },
      {
        tool: "update_category",
        scopes: ["categories:write"],
        extra: "categories:read",
        sentinel: "Food",
      },
      {
        tool: "list_transactions",
        scopes: ["transactions:read"],
        extra: "bills:read",
        sentinel: "billIds",
      },
    ];

    it.each(cases)(
      "$tool: $sentinel needs $extra",
      async ({ tool, scopes, extra, sentinel }) => {
        const x = await build();
        const without = await run(x, tool, scopes);
        expect(without.text).not.toContain(sentinel);
        const withExtra = await run(x, tool, [...scopes, extra]);
        expect(withExtra.text).toContain(sentinel);
      },
    );
  });

  it("returns only id, category and note from update_transaction(s) without transactions:read", async () => {
    const x = await build();
    const { token } = await seedToken(x.w.a.id, ["transactions:write"]);
    const one = await callTool(token, "update_transaction", {
      paymentId: x.w.t1.id,
      note: "mine",
      categoryId: x.w.rent.id,
    });
    expect(one.data).toEqual({
      id: x.w.t1.id,
      categoryId: x.w.rent.id,
      note: "mine",
    });
    const many = await callTool(token, "update_transactions", {
      changes: [{ paymentId: x.w.t1.id, note: "again" }],
    });
    expect(many.data).toEqual({ updated: 1 });
  });

  it("shows a bill's allocations as ids and amounts only without transactions:read", async () => {
    const x = await build();
    const { token } = await seedToken(x.w.a.id, ["bills:read"]);
    const r = await callTool(token, "get_bill", { billId: x.w.bill2.id });
    const allocations = r.data.allocations as Record<string, unknown>[];
    expect(allocations).toHaveLength(2);
    for (const a of allocations) {
      expect(Object.keys(a).sort()).toEqual([
        "allocationId",
        "amount",
        "origin",
        "paymentId",
      ]);
    }
  });

  it("refuses the unmatched filter without bills:read, since it tells which payments have a bill", async () => {
    const x = await build();
    const { token } = await seedToken(x.w.a.id, ["transactions:read"]);
    const r = await callTool(token, "list_transactions", { unmatched: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/bills:read/);
    const ok = await callTool(token, "list_transactions", {});
    expect(ok.isError).toBe(false);
    expect(ok.text).not.toContain("billIds");
  });

  it("names a change's creditor, counterparty or category in list_changes only with the matching read scope", async () => {
    const x = await build();
    const changes = async (scopes: ApiScope[]) => {
      const { token } = await seedToken(x.w.a.id, scopes);
      await callTool(token, "create_bill", {
        creditorName: "Fresh Creditor",
        amount: "2.00",
      });
      await callTool(token, "update_transaction", {
        paymentId: x.w.t1.id,
        note: `n${scopes.length}`,
      });
      await callTool(token, "update_category", {
        categoryId: x.w.food.id,
        color: scopes.length > 4 ? "#445566" : "#556677",
      });
      const listed = await callTool(token, "list_changes", {});
      expect(listed.isError, listed.text).toBe(false);
      return listed;
    };
    const writes: ApiScope[] = [
      "bills:write",
      "transactions:write",
      "categories:write",
      "changes:read",
    ];

    const bare = await changes(writes);
    const items = bare.data.items as { summary: unknown }[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((e) => e.summary === null)).toBe(true);
    expect(leaks(bare.text, KINDS)).toEqual([]);

    const reading = await changes([
      ...writes,
      "bills:read",
      "transactions:read",
      "categories:read",
    ]);
    expect(reading.text).toContain("Fresh Creditor");
    expect(reading.text).toContain("Shop One");
    expect(reading.text).toContain("Food");
  });
});
