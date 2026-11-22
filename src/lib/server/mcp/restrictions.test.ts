import { afterAll, afterEach, describe, expect, it } from "vitest";
import { API_SCOPES, type ApiScope } from "$lib/api-tokens";
import { minor } from "$lib/money";
import { listChanges } from "$lib/server/audit";
import { billAllocations, getDB } from "$lib/server/db";
import { apiAuthFailureLimiter } from "$lib/server/external-api/gate";
import { allocate } from "$lib/server/bills/allocations";
import { useTestDB } from "$lib/testing/db";
import { seedToken } from "$lib/testing/external-api";
import {
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { seedBill } from "$lib/testing/bills";
import { seedSecurity, seedTrade } from "$lib/testing/investments";
import {
  callTool as rawCallTool,
  listToolNames,
  type ToolOutcome,
} from "$lib/testing/mcp";
import { buildWorld, type World } from "$lib/testing/mcp-world";
import { mcpTokenLimiter } from "./gate";
import { TOOLS } from "./tools/index";
import { toolAvailable } from "./tool";
import { grantFromApiToken } from "$lib/server/auth/grant";

afterEach(() => {
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

/** Every scope a tool can use. `categories:write` etc. are stored on purpose: the request path must drop them. */
const ALL = API_SCOPES.filter((s) => s !== "links:write");

type Rows = Record<string, unknown>[];
const ids = (rows: unknown) => (rows as Rows).map((r) => r.id);

/** Tools probed with data outside a restriction; see the table in `probes` below. */
const probed = new Set<string>();

async function world() {
  const w = await buildWorld();
  const full = await seedToken(w.a.id, ALL, { name: "full" });
  const mk = async (over: {
    accountIds?: string[] | null;
    categoryIds?: string[] | null;
    scopes?: readonly ApiScope[];
  }) => {
    const t = await seedToken(w.a.id, over.scopes ?? ALL, {
      accountIds: over.accountIds ?? null,
      categoryIds: over.categoryIds ?? null,
      name: "restricted",
    });
    const call = async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<ToolOutcome> => {
      probed.add(name);
      return rawCallTool(t.token, name, args);
    };
    const ok = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      return r.data;
    };
    const notFound = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      expect(r.isError, `${name} should be refused`).toBe(true);
      expect(r.text).toMatch(/not found/i);
    };
    return { ...t, call, ok, notFound };
  };
  const fullCall = (name: string, args: Record<string, unknown> = {}) =>
    rawCallTool(full.token, name, args);
  return { w, mk, full, fullCall };
}

const qrBill = (w: World, amount = 5000) =>
  seedBill(w.a.id, {
    creditorIban: EXAMPLE_IBAN_OTHER,
    reference: EXAMPLE_QRR,
    referenceType: "QRR",
    amount: minor(amount),
    issueDate: "2026-03-01",
    dueDate: "2026-04-01",
  });

describe("mcp restrictions: which tools a grant gets", () => {
  useTestDB();

  const available = (scopes: readonly ApiScope[], over: object) =>
    TOOLS.filter((t) =>
      toolAvailable(
        t,
        grantFromApiToken({
          id: "t",
          userId: "u",
          name: "n",
          scopes: [...scopes],
          categoryIds: null,
          accountIds: null,
          ...over,
        }),
      ),
    ).map((t) => t.name);

  it("hides what cannot honour an account restriction, though the token holds the scope", async () => {
    const { mk, w } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });
    const names = await listToolNames(acc.token);
    for (const hidden of [
      "get_net_worth",
      "list_category_rules",
      "list_recurring_payments",
      "get_budgets",
      "get_forecast",
      "list_planned_items",
      "get_pillar3a",
      "list_tax_years",
      "get_tax_year",
      "create_category",
      "update_category",
      "delete_category",
      "create_category_rule",
      "update_category_rule",
      "delete_category_rule",
      "apply_category_rules",
    ]) {
      expect(names, hidden).not.toContain(hidden);
      const refused = await acc.call(hidden, {});
      expect(refused.isError, hidden).toBe(true);
    }
    for (const shown of [
      "get_balances",
      "get_investments",
      "list_accounts",
      "list_transactions",
      "update_transaction",
      "list_bills",
      "allocate_payment",
      "run_auto_match",
      "list_changes",
      "revert_change",
    ]) {
      expect(names, shown).toContain(shown);
    }
  });

  it("hides what cannot honour a category restriction", async () => {
    const { mk, w } = await world();
    const cat = await mk({ categoryIds: [w.food.id] });
    const names = await listToolNames(cat.token);
    for (const hidden of [
      "get_balances",
      "get_net_worth",
      "get_investments",
      "get_budgets",
      "list_recurring_payments",
      "get_forecast",
      "get_pillar3a",
      "get_tax_year",
      "create_category",
      "apply_category_rules",
    ]) {
      expect(names, hidden).not.toContain(hidden);
    }
    for (const shown of [
      "list_transactions",
      "list_categories",
      "list_category_rules",
      "list_accounts",
      "update_transaction",
      "list_bills",
    ]) {
      expect(names, shown).toContain(shown);
    }
  });

  it("an unrestricted grant keeps every tool its scopes allow", () => {
    expect(available(ALL, {})).toEqual(TOOLS.map((t) => t.name));
  });

  it("drops a conflicting scope from a restricted token that was stored with it", () => {
    const grant = grantFromApiToken({
      id: "t",
      userId: "u",
      name: "n",
      scopes: ["recurring:read", "bills:read", "categories:write"],
      categoryIds: ["c"],
      accountIds: null,
    });
    expect(grant.scopes).toEqual(["bills:read"]);
  });
});

describe("mcp restrictions: an account-restricted connection", () => {
  useTestDB();

  it("only reads payments, accounts and balances of its accounts", async () => {
    const { w, mk } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });

    expect(ids((await acc.ok("list_transactions")).items)).toEqual([
      w.t5.id,
      w.t2.id,
      w.t1.id,
    ]);
    for (const hidden of [w.t3.id, w.t4.id, w.bTx.id]) {
      await acc.notFound("get_transaction", { paymentId: hidden });
    }
    expect(
      (await acc.ok("list_transactions", { accountId: w.savings.id })).items,
    ).toEqual([]);
    expect(
      ids((await acc.ok("list_transactions", { uncategorized: true })).items),
    ).toEqual([w.t5.id]);
    expect(
      ids((await acc.ok("list_transactions", { q: "snacks" })).items),
    ).toEqual([]);
    expect(
      ids((await acc.ok("list_transactions", { limit: 1 })).items),
    ).toEqual([w.t5.id]);

    const accounts = await acc.ok("list_accounts");
    expect((accounts.items as Rows).map((a) => a.name)).toEqual(["Checking"]);

    const balances = await acc.ok("get_balances");
    expect((balances.accounts as Rows).map((a) => a.name)).toEqual([
      "Checking",
    ]);
    expect(balances.totals).toEqual([
      { currency: "CHF", balance: "-115.50", accountCount: 1 },
    ]);

    const me = await acc.ok("whoami");
    expect(me.restrictions).toEqual({
      accounts: [{ id: w.checking.id, name: "Checking" }],
      categories: null,
    });
  });

  it("sees bills, but only the payments it can see on them", async () => {
    const { w, mk, full } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });
    // t2 (checking) and t4 (savings) both pay part of the same bill.
    await allocate(w.a.id, w.bill1.id, w.t2.id, minor(6000), "user");
    await allocate(w.a.id, w.bill1.id, w.t4.id, minor(700), "user");

    const bill = await acc.ok("get_bill", { billId: w.bill1.id });
    expect((bill.allocations as Rows).map((a) => a.paymentId)).toEqual([
      w.t2.id,
    ]);
    // paidAmount counts payments of every account: documented and kept.
    expect(bill.paidAmount).toBe("67.00");
    expect(ids((await acc.ok("list_bills")).items)).toEqual([
      w.bill1.id,
      w.bill2.id,
    ]);
    expect(full.token).toBeTruthy();
  });

  it("offers only visible payments as candidates and suggestions", async () => {
    const { w, mk } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });
    const candidates = await acc.ok("list_payment_candidates", {
      billId: w.bill2.id,
    });
    expect((candidates.items as Rows).map((c) => c.paymentId).sort()).toEqual(
      [w.t1.id, w.t2.id, w.t5.id].sort(),
    );

    const bill = await qrBill(w);
    const hidden = await seedImportedTransaction(w.a.id, w.savings.id, {
      amount: minor(-5000),
      bookingDate: "2026-03-20",
      reference: EXAMPLE_QRR,
    });
    expect(
      (await acc.ok("list_match_suggestions", { billId: bill.id })).items,
    ).toEqual([]);
    const full = await seedToken(w.a.id, ALL);
    const seen = await rawCallTool(full.token, "list_match_suggestions", {
      billId: bill.id,
    });
    expect((seen.data.items as Rows).map((s) => s.paymentId)).toEqual([
      hidden.id,
    ]);
  });

  it("cannot write to payments outside its accounts", async () => {
    const { w, mk } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });

    await acc.notFound("update_transaction", {
      paymentId: w.t3.id,
      note: "nope",
    });
    await acc.notFound("update_transactions", {
      changes: [
        { paymentId: w.t1.id, note: "should not stick" },
        { paymentId: w.t4.id, categoryId: w.rent.id },
      ],
    });
    await acc.notFound("allocate_payment", {
      billId: w.bill2.id,
      paymentId: w.t3.id,
      amount: "5.00",
    });
    await acc.notFound("dismiss_suggestion", {
      billId: w.bill2.id,
      paymentId: w.t3.id,
    });
    const fresh = await seedToken(w.a.id, ALL);
    const t3 = await rawCallTool(fresh.token, "get_transaction", {
      paymentId: w.t3.id,
    });
    expect(t3.data).toMatchObject({ note: null, categoryId: w.food.id });
    const t1 = await rawCallTool(fresh.token, "get_transaction", {
      paymentId: w.t1.id,
    });
    expect(t1.data.note).toBeNull();
    expect(await getDB().select().from(billAllocations)).toEqual([]);
    expect(await listChanges(w.a.id, { tokenId: acc.info.id })).toMatchObject({
      items: [],
    });

    // Inside its accounts it may.
    await acc.ok("update_transaction", { paymentId: w.t1.id, note: "ok" });
    await acc.ok("allocate_payment", {
      billId: w.bill2.id,
      paymentId: w.t5.id,
      amount: "3.00",
    });
  });

  it("cannot remove an allocation of a payment it cannot see", async () => {
    const { w, mk } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });
    const hidden = await allocate(
      w.a.id,
      w.bill1.id,
      w.t4.id,
      minor(700),
      "user",
    );
    const visible = await allocate(
      w.a.id,
      w.bill1.id,
      w.t2.id,
      minor(5000),
      "user",
    );
    await acc.notFound("remove_allocation", { allocationId: hidden.id });
    expect((await getDB().select().from(billAllocations)).length).toBe(2);
    await acc.ok("remove_allocation", { allocationId: visible.id });
    expect((await getDB().select().from(billAllocations)).length).toBe(1);
  });

  it("auto-matches only payments it can see", async () => {
    const { w, mk, fullCall } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });
    const bill = await qrBill(w);
    await seedImportedTransaction(w.a.id, w.savings.id, {
      amount: minor(-5000),
      bookingDate: "2026-03-20",
      reference: EXAMPLE_QRR,
    });
    expect(await acc.ok("run_auto_match")).toMatchObject({ matched: 0 });
    expect(await getDB().select().from(billAllocations)).toEqual([]);
    expect((await fullCall("run_auto_match")).data).toMatchObject({
      matched: 1,
    });
    expect(bill.id).toBeTruthy();
  });

  it("cannot name a hidden account on a bill, nor delete a bill that has hidden payments", async () => {
    const { w, mk } = await world();
    const acc = await mk({ accountIds: [w.checking.id] });
    await acc.notFound("create_bill", {
      creditorName: "X",
      amount: "1.00",
      expectedAccountId: w.savings.id,
    });
    await acc.notFound("update_bill", {
      billId: w.bill2.id,
      expectedAccountId: w.savings.id,
    });
    const own = await acc.ok("create_bill", {
      creditorName: "X",
      amount: "1.00",
      expectedAccountId: w.checking.id,
    });
    expect(own.id).toBeTruthy();

    await allocate(w.a.id, w.bill1.id, w.t4.id, minor(700), "user");
    const refused = await acc.call("delete_bill", { billId: w.bill1.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/cannot see/i);
    await acc.ok("delete_bill", { billId: w.bill2.id });
  });

  it("counts only its accounts' holdings", async () => {
    const { w, mk } = await world();
    const mine = await seedAccount(w.a.id, {
      name: "Mine",
      type: "investment",
    });
    const theirs = await seedAccount(w.a.id, {
      name: "Theirs",
      type: "investment",
    });
    const etf = await seedSecurity(w.a.id);
    await seedTrade(w.a.id, mine.id, etf.id, { qty: "10", amount: -100000 });
    await seedTrade(w.a.id, theirs.id, etf.id, { qty: "3", amount: -30000 });
    const acc = await mk({ accountIds: [mine.id] });
    const o = await acc.ok("get_investments");
    const positions = (o.securities as { positions: Rows }[]).flatMap(
      (s) => s.positions,
    );
    expect(positions.map((p) => p.accountName)).toEqual(["Mine"]);
    expect(positions[0]).toMatchObject({ quantity: "10" });
    const full = await seedToken(w.a.id, ALL);
    const all = await rawCallTool(full.token, "get_investments");
    expect(
      (all.data.securities as { positions: Rows }[])[0]!.positions,
    ).toHaveLength(2);
  });

  it("an empty list of accounts sees nothing at all", async () => {
    const { w, mk } = await world();
    const none = await mk({ accountIds: [] });
    expect((await none.ok("list_transactions")).items).toEqual([]);
    expect((await none.ok("list_accounts")).items).toEqual([]);
    expect((await none.ok("get_balances")).accounts).toEqual([]);
    await none.notFound("get_transaction", { paymentId: w.t1.id });
  });
});

describe("mcp restrictions: a category-restricted connection", () => {
  useTestDB();

  it("only reads payments in its categories", async () => {
    const { w, mk } = await world();
    const cat = await mk({ categoryIds: [w.food.id] });
    expect(ids((await cat.ok("list_transactions")).items)).toEqual([
      w.t3.id,
      w.t1.id,
    ]);
    await cat.notFound("get_transaction", { paymentId: w.t2.id });
    await cat.notFound("get_transaction", { paymentId: w.t5.id });
    expect(
      (await cat.ok("list_transactions", { categoryId: w.rent.id })).items,
    ).toEqual([]);
    expect(
      (await cat.ok("list_transactions", { uncategorized: true })).items,
    ).toEqual([]);
    expect(
      ids((await cat.ok("list_transactions", { uncategorized: false })).items),
    ).toEqual([w.t3.id, w.t1.id]);

    const cats = await cat.ok("list_categories");
    expect((cats.items as Rows).map((c) => c.name)).toEqual(["Food"]);
    const rules = await cat.ok("list_category_rules");
    expect(rules.items).toEqual([]);
    const me = await cat.ok("whoami");
    expect(me.restrictions).toEqual({
      accounts: null,
      categories: [{ id: w.food.id, name: "Food" }],
    });
  });

  it("only files payments under its own categories", async () => {
    const { w, mk } = await world();
    const cat = await mk({ categoryIds: [w.food.id] });
    await cat.notFound("update_transaction", {
      paymentId: w.t2.id,
      note: "hidden payment",
    });
    await cat.notFound("update_transaction", {
      paymentId: w.t1.id,
      categoryId: w.rent.id,
    });
    const clear = await cat.call("update_transaction", {
      paymentId: w.t1.id,
      categoryId: null,
    });
    expect(clear.isError).toBe(true);
    expect(clear.text).toMatch(/own categories/i);
    await cat.notFound("allocate_payment", {
      billId: w.bill1.id,
      paymentId: w.t2.id,
      amount: "100.00",
    });
    await cat.ok("update_transaction", {
      paymentId: w.t1.id,
      categoryId: w.food.id,
      note: "fine",
    });
    await cat.ok("update_transactions", {
      changes: [{ paymentId: w.t3.id, note: "fine too" }],
    });
    const check = await seedToken(w.a.id, ALL);
    const t1 = await rawCallTool(check.token, "get_transaction", {
      paymentId: w.t1.id,
    });
    expect(t1.data).toMatchObject({ categoryId: w.food.id, note: "fine" });
    const t2 = await rawCallTool(check.token, "get_transaction", {
      paymentId: w.t2.id,
    });
    expect(t2.data).toMatchObject({ categoryId: w.rent.id, note: null });
  });

  it("offers only payments in its categories as candidates", async () => {
    const { w, mk } = await world();
    const cat = await mk({ categoryIds: [w.rent.id] });
    const candidates = await cat.ok("list_payment_candidates", {
      billId: w.bill1.id,
    });
    expect((candidates.items as Rows).map((c) => c.paymentId)).toEqual([
      w.t2.id,
    ]);
  });

  it("combines with an account restriction", async () => {
    const { w, mk } = await world();
    const both = await mk({
      accountIds: [w.savings.id],
      categoryIds: [w.food.id],
    });
    expect(ids((await both.ok("list_transactions")).items)).toEqual([w.t3.id]);
  });
});

describe("mcp restrictions: other users' data", () => {
  useTestDB();

  it("never shows user B's rows to A's credentials, whatever the ids", async () => {
    const { w, mk } = await world();
    const full = await mk({});
    const reads: [string, Record<string, unknown>][] = [
      ["get_bill", { billId: w.bBill.id }],
      ["get_transaction", { paymentId: w.bTx.id }],
      ["list_payment_candidates", { billId: w.bBill.id }],
    ];
    for (const [name, args] of reads) await full.notFound(name, args);
    const writes: [string, Record<string, unknown>][] = [
      ["update_bill", { billId: w.bBill.id, notes: "x" }],
      ["set_bill_cancelled", { billId: w.bBill.id, cancelled: true }],
      ["delete_bill", { billId: w.bBill.id }],
      ["update_transaction", { paymentId: w.bTx.id, note: "x" }],
      ["update_category", { categoryId: w.bFood.id, name: "x" }],
      ["delete_category", { categoryId: w.bFood.id }],
      ["update_transaction", { paymentId: w.t1.id, categoryId: w.bFood.id }],
    ];
    for (const [name, args] of writes) {
      const r = await full.call(name, args);
      expect(r.isError, name).toBe(true);
    }
    for (const name of [
      "list_bills",
      "list_transactions",
      "list_accounts",
      "list_categories",
      "get_balances",
      "list_category_rules",
      "list_changes",
      "get_budgets",
      "list_recurring_payments",
      "get_forecast",
      "get_investments",
      "get_pillar3a",
      "list_tax_years",
      "list_planned_items",
      "get_net_worth",
    ]) {
      const text = (await full.call(name)).text;
      for (const foreign of [
        w.bBill.id,
        w.bTx.id,
        w.bAccount.id,
        w.bFood.id,
        "Foreign",
        "Other checking",
      ]) {
        expect(text, `${name} leaks ${foreign}`).not.toContain(foreign);
      }
    }
    // B's own token sees B's data and none of A's.
    const b = await seedToken(w.b.id, ALL);
    const mine = await rawCallTool(b.token, "list_transactions");
    expect(ids(mine.data.items)).toEqual([w.bTx.id]);
    const theirs = await rawCallTool(b.token, "get_transaction", {
      paymentId: w.t1.id,
    });
    expect(theirs.isError).toBe(true);
    const allocation = await rawCallTool(b.token, "allocate_payment", {
      billId: w.bBill.id,
      paymentId: w.t1.id,
      amount: "1.00",
    });
    expect(allocation.isError).toBe(true);
  });
});

/**
 * Every tool is either probed above with data outside a restriction, or it
 * is one of these, with the reason it needs no probe. A new tool fails this
 * test until it is classified.
 */
const UNPROBED: Record<string, string> = {
  set_bill_cancelled: "acts on a bill, which no restriction hides",
  list_bills: "bills are not restricted; paidAmount is documented",
  create_category: "unavailable to any restriction",
  update_category: "unavailable to any restriction",
  delete_category: "unavailable to any restriction",
  create_category_rule: "unavailable to any restriction",
  update_category_rule: "unavailable to any restriction",
  delete_category_rule: "unavailable to any restriction",
  apply_category_rules: "unavailable to any restriction",
  get_budgets: "unavailable to any restriction",
  list_recurring_payments: "unavailable to any restriction",
  get_forecast: "unavailable to any restriction",
  list_planned_items: "unavailable to any restriction",
  get_pillar3a: "unavailable to any restriction",
  list_tax_years: "unavailable to any restriction",
  get_tax_year: "unavailable to any restriction",
  get_net_worth: "unavailable to account restrictions, balances to categories",
  revert_change: "only the connection's own changes, tested in tools.test.ts",
  revert_changes: "only the connection's own changes, tested in tools.test.ts",
  list_changes: "only the connection's own changes, tested in tools.test.ts",
};

afterAll(() => {
  for (const tool of TOOLS) {
    expect(
      probed.has(tool.name) || tool.name in UNPROBED,
      `${tool.name} is neither probed with restricted grants nor listed in UNPROBED`,
    ).toBe(true);
  }
  expect(TOOLS.length).toBeGreaterThan(30);
});
