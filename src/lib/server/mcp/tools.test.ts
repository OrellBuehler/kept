import { afterAll, afterEach, describe, expect, it } from "vitest";
import { API_SCOPES } from "$lib/api-tokens";
import { minor } from "$lib/money";
import { listChanges } from "$lib/server/audit";
import { billAllocations, getDB } from "$lib/server/db";
import { apiAuthFailureLimiter } from "$lib/server/external-api/gate";
import { createCategory } from "$lib/server/categories";
import { createBill } from "$lib/server/bills/bills";
import {
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedImportedTransaction } from "$lib/testing/ledger";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedToken } from "$lib/testing/external-api";
import {
  callTool as rawCallTool,
  listToolNames,
  type ToolOutcome,
} from "$lib/testing/mcp";
import { buildWorld, type World } from "$lib/testing/mcp-world";
import { mcpTokenLimiter } from "./gate";
import { TOOLS } from "./tools/index";

afterEach(() => {
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

const called = new Set<string>();

type Rows = Record<string, unknown>[];

/** Scopes that carry a tool; `links:write` has none (REST only), and `categories:write` conflicts with restrictions. */
const FULL = API_SCOPES.filter((s) => s !== "links:write");

async function setup(scopes: readonly (typeof API_SCOPES)[number][] = FULL) {
  const w = await buildWorld();
  const { token, info } = await seedToken(w.a.id, scopes);
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolOutcome> => {
    called.add(name);
    return rawCallTool(token, name, args);
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.isError, `${name}: ${r.text}`).toBe(false);
    return r.data;
  };
  return { w, token, info, call, ok };
}

const ids = (rows: unknown) => (rows as Rows).map((r) => r.id);

describe("mcp tools: bills", () => {
  useTestDB();

  it("lists the owner's bills with decimal amounts, filters and pages", async () => {
    const { w, ok } = await setup();
    const all = await ok("list_bills");
    expect(ids(all.items)).toEqual([w.bill1.id, w.bill2.id]);
    expect((all.items as Rows)[0]).toMatchObject({
      creditorName: "Example Supplier",
      amount: "100.00",
      currency: "CHF",
      status: "open",
      paidAmount: "0.00",
      remainingAmount: "100.00",
    });
    expect(JSON.stringify(all)).not.toContain(w.bBill.id);

    const page1 = await ok("list_bills", { limit: 1 });
    expect(ids(page1.items)).toEqual([w.bill1.id]);
    const page2 = await ok("list_bills", {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(ids(page2.items)).toEqual([w.bill2.id]);
    expect(page2.nextCursor).toBeNull();

    expect(ids((await ok("list_bills", { q: "second" })).items)).toEqual([
      w.bill2.id,
    ]);
    expect(
      ids((await ok("list_bills", { dueTo: "2026-04-30" })).items),
    ).toEqual([w.bill1.id]);
    expect(ids((await ok("list_bills", { status: ["paid"] })).items)).toEqual(
      [],
    );
  });

  it("rejects malformed input as a tool error, not a crash", async () => {
    const { call } = await setup();
    const bad = await call("list_bills", { limit: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/limit/i);
    expect((await call("list_bills", { dueFrom: "yesterday" })).isError).toBe(
      true,
    );
    expect((await call("list_bills", { surprise: 1 })).isError).toBe(true);
  });

  it("gets one bill, and another user's bill is not found", async () => {
    const { w, ok, call } = await setup();
    const bill = await ok("get_bill", { billId: w.bill1.id });
    expect(bill).toMatchObject({
      id: w.bill1.id,
      amount: "100.00",
      allocations: [],
    });
    const foreign = await call("get_bill", { billId: w.bBill.id });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toMatch(/not found/i);
  });

  it("creates, updates, cancels and deletes a bill, each recorded as this connection", async () => {
    const { w, info, ok, call } = await setup();
    const created = await ok("create_bill", {
      creditorName: "New Creditor",
      amount: "45.50",
      dueDate: "2026-06-01",
      notes: "first note",
    });
    expect(created).toMatchObject({
      creditorName: "New Creditor",
      amount: "45.50",
      currency: "CHF",
      notes: "first note",
      dueDate: "2026-06-01",
    });
    const id = created.id as string;

    const updated = await ok("update_bill", {
      billId: id,
      amount: "50",
      notes: null,
      dueDate: "2026-07-01",
    });
    expect(updated).toMatchObject({
      creditorName: "New Creditor",
      amount: "50.00",
      notes: null,
      dueDate: "2026-07-01",
    });

    expect(
      await ok("set_bill_cancelled", { billId: id, cancelled: true }),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await ok("set_bill_cancelled", { billId: id, cancelled: false }),
    ).toMatchObject({ status: "open" });

    expect(await ok("delete_bill", { billId: id })).toEqual({
      deleted: true,
      billId: id,
    });
    expect((await call("get_bill", { billId: id })).isError).toBe(true);

    const log = (await listChanges(w.a.id, { tokenId: info.id })).items;
    expect(log.map((e) => e.action).sort()).toEqual([
      "bill.cancel",
      "bill.create",
      "bill.delete",
      "bill.uncancel",
      "bill.update",
    ]);
    for (const e of log) {
      expect(e.actor).toMatchObject({
        kind: "mcp",
        tokenId: info.id,
        label: "test token",
      });
    }
  });

  it("refuses an invalid bill with the field named", async () => {
    const { call } = await setup();
    const zero = await call("create_bill", {
      creditorName: "X",
      amount: "0",
    });
    expect(zero.isError).toBe(true);
    expect(zero.text).toMatch(/amount/i);
    const nobody = await call("create_bill", { amount: "5" });
    expect(nobody.isError).toBe(true);
    const badCurrency = await call("create_bill", {
      creditorName: "X",
      currency: "ZZ",
    });
    expect(badCurrency.isError).toBe(true);
  });

  it("does not update or delete another user's bill", async () => {
    const { w, call } = await setup();
    expect(
      (await call("update_bill", { billId: w.bBill.id, notes: "x" })).isError,
    ).toBe(true);
    expect(
      (
        await call("set_bill_cancelled", {
          billId: w.bBill.id,
          cancelled: true,
        })
      ).isError,
    ).toBe(true);
    expect((await call("delete_bill", { billId: w.bBill.id })).isError).toBe(
      true,
    );
  });
});

describe("mcp tools: matching", () => {
  useTestDB();

  it("allocates a payment, shows it on the bill, and removes it again", async () => {
    const { w, info, ok, call } = await setup();
    const candidates = await ok("list_payment_candidates", {
      billId: w.bill1.id,
    });
    const paymentIds = (candidates.items as Rows).map((i) => i.paymentId);
    expect(paymentIds).toContain(w.t2.id);
    expect(paymentIds).not.toContain(w.bTx.id);
    expect(
      (candidates.items as Rows).find((i) => i.paymentId === w.t2.id),
    ).toMatchObject({ unallocated: "-100.00", suggestedAmount: "100.00" });

    const created = await ok("allocate_payment", {
      billId: w.bill1.id,
      paymentId: w.t2.id,
      amount: "100.00",
    });
    const bill = await ok("get_bill", { billId: w.bill1.id });
    expect(bill).toMatchObject({ status: "paid", remainingAmount: "0.00" });
    expect(bill.allocations).toEqual([
      expect.objectContaining({
        allocationId: created.allocationId,
        paymentId: w.t2.id,
        amount: "100.00",
      }),
    ]);
    const tx = await ok("get_transaction", { paymentId: w.t2.id });
    expect(tx.billIds).toEqual([w.bill1.id]);

    const over = await call("allocate_payment", {
      billId: w.bill2.id,
      paymentId: w.t2.id,
      amount: "25.00",
    });
    expect(over.isError).toBe(true);

    await ok("remove_allocation", { allocationId: created.allocationId });
    expect((await ok("get_bill", { billId: w.bill1.id })).allocations).toEqual(
      [],
    );
    const log = await listChanges(w.a.id, { tokenId: info.id });
    expect(log.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(["allocation.create", "allocation.delete"]),
    );
  });

  it("will not allocate another user's payment or to another user's bill", async () => {
    const { w, call } = await setup();
    const foreignPayment = await call("allocate_payment", {
      billId: w.bill1.id,
      paymentId: w.bTx.id,
      amount: "1.00",
    });
    expect(foreignPayment.isError).toBe(true);
    const foreignBill = await call("allocate_payment", {
      billId: w.bBill.id,
      paymentId: w.t1.id,
      amount: "1.00",
    });
    expect(foreignBill.isError).toBe(true);
    expect(await getDB().select().from(billAllocations)).toEqual([]);
  });

  it("suggests, dismisses and auto-matches", async () => {
    const { w, info, ok } = await setup();
    const bill = await seedBill(w.a.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      amount: minor(5000),
      issueDate: "2026-03-01",
      dueDate: "2026-04-01",
    });
    const payment = await seedImportedTransaction(w.a.id, w.checking.id, {
      amount: minor(-5000),
      bookingDate: "2026-03-20",
      reference: EXAMPLE_QRR,
      counterpartyName: "QR Creditor",
    });

    const suggestions = await ok("list_match_suggestions", {
      billId: bill.id,
    });
    expect(suggestions.items).toEqual([
      expect.objectContaining({
        billId: bill.id,
        paymentId: payment.id,
        amount: "50.00",
        auto: true,
      }),
    ]);

    await ok("dismiss_suggestion", { billId: bill.id, paymentId: payment.id });
    expect(
      (await ok("list_match_suggestions", { billId: bill.id })).items,
    ).toEqual([]);

    // A dismissed pair is never confirmed automatically.
    expect(await ok("run_auto_match")).toMatchObject({ matched: 0 });

    const other = await seedBill(w.a.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      amount: minor(5000),
      issueDate: "2026-03-01",
      dueDate: "2026-04-01",
    });
    expect(other.id).not.toBe(bill.id);
    const log = await listChanges(w.a.id, { tokenId: info.id });
    expect(log.items.map((e) => e.action)).toContain("match_dismissal.create");
  });

  it("run_auto_match confirms an exact reference match as an automatic allocation", async () => {
    const { w, info, ok } = await setup();
    const bill = await seedBill(w.a.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      amount: minor(5000),
      issueDate: "2026-03-01",
      dueDate: "2026-04-01",
    });
    await seedImportedTransaction(w.a.id, w.checking.id, {
      amount: minor(-5000),
      bookingDate: "2026-03-20",
      reference: EXAMPLE_QRR,
    });
    expect(await ok("run_auto_match")).toMatchObject({
      matched: 1,
      remainingSuggestions: 0,
    });
    expect(await ok("get_bill", { billId: bill.id })).toMatchObject({
      status: "paid",
    });
    expect(
      (await listChanges(w.a.id, { tokenId: info.id })).items.map(
        (e) => e.action,
      ),
    ).toContain("allocation.auto_match");
  });
});

describe("mcp tools: transactions", () => {
  useTestDB();

  it("lists payments with filters, pages and decimal amounts", async () => {
    const { w, ok } = await setup();
    const all = await ok("list_transactions");
    expect(ids(all.items)).toEqual([
      w.t5.id,
      w.t4.id,
      w.t3.id,
      w.t2.id,
      w.t1.id,
    ]);
    expect((all.items as Rows)[4]).toMatchObject({
      amount: "-12.50",
      currency: "CHF",
      accountId: w.checking.id,
      categoryId: w.food.id,
      counterpartyName: "Shop One",
    });
    expect(JSON.stringify(all)).not.toContain(w.bTx.id);

    const page1 = await ok("list_transactions", { limit: 2 });
    const page2 = await ok("list_transactions", {
      limit: 2,
      cursor: page1.nextCursor,
    });
    const page3 = await ok("list_transactions", {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect([
      ...ids(page1.items),
      ...ids(page2.items),
      ...ids(page3.items),
    ]).toEqual(ids(all.items));
    expect(page3.nextCursor).toBeNull();

    const by = async (args: Record<string, unknown>) =>
      ids((await ok("list_transactions", args)).items);
    expect(await by({ accountId: w.savings.id })).toEqual([w.t4.id, w.t3.id]);
    expect(await by({ categoryId: w.rent.id })).toEqual([w.t2.id]);
    expect(await by({ from: "2026-03-12", to: "2026-03-13" })).toEqual([
      w.t4.id,
      w.t3.id,
    ]);
    expect(await by({ q: "coffee" })).toEqual([w.t5.id]);
    expect(await by({ uncategorized: true })).toEqual([w.t5.id, w.t4.id]);
    expect(await by({ unmatched: true })).toHaveLength(5);
    await ok("allocate_payment", {
      billId: w.bill1.id,
      paymentId: w.t2.id,
      amount: "100.00",
    });
    expect(await by({ unmatched: false })).toEqual([w.t2.id]);
    expect(await by({ unmatched: true })).toHaveLength(4);
  });

  it("gets a payment with its note, and not another user's", async () => {
    const { w, ok, call } = await setup();
    const tx = await ok("get_transaction", { paymentId: w.t1.id });
    expect(tx).toMatchObject({ id: w.t1.id, note: null, amount: "-12.50" });
    expect(
      (await call("get_transaction", { paymentId: w.bTx.id })).isError,
    ).toBe(true);
  });

  it("sets category and note on one payment and on a batch, recorded as this connection", async () => {
    const { w, info, ok, call } = await setup();
    const one = await ok("update_transaction", {
      paymentId: w.t4.id,
      categoryId: w.food.id,
      note: "bought on the way",
    });
    expect(one).toMatchObject({
      categoryId: w.food.id,
      note: "bought on the way",
      amount: "-7.00",
    });

    const batch = await ok("update_transactions", {
      changes: [
        { paymentId: w.t5.id, categoryId: w.rent.id },
        { paymentId: w.t1.id, note: "n1" },
        { paymentId: w.t3.id, categoryId: null },
      ],
    });
    expect(batch).toEqual({ updated: 3 });
    expect(await ok("get_transaction", { paymentId: w.t5.id })).toMatchObject({
      categoryId: w.rent.id,
    });
    expect(await ok("get_transaction", { paymentId: w.t3.id })).toMatchObject({
      categoryId: null,
    });

    const log = await listChanges(w.a.id, { tokenId: info.id });
    expect(log.items.length).toBeGreaterThanOrEqual(4);
    for (const e of log.items) {
      expect(e).toMatchObject({
        action: "transaction.update",
        actor: { kind: "mcp", tokenId: info.id },
      });
    }

    // The amount is not something this tool can touch.
    const sneaky = await call("update_transaction", {
      paymentId: w.t1.id,
      amount: "1.00",
    });
    expect(sneaky.isError).toBe(true);
    expect(await ok("get_transaction", { paymentId: w.t1.id })).toMatchObject({
      amount: "-12.50",
    });
  });

  it("refuses a batch as a whole when one entry is wrong", async () => {
    const { w, ok, call } = await setup();
    const result = await call("update_transactions", {
      changes: [
        { paymentId: w.t1.id, note: "should not stick" },
        { paymentId: w.bTx.id, note: "foreign" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(await ok("get_transaction", { paymentId: w.t1.id })).toMatchObject({
      note: null,
    });
    expect(
      (
        await call("update_transactions", {
          changes: [{ paymentId: w.t1.id, categoryId: w.bFood.id }],
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call("update_transactions", {
          changes: [
            { paymentId: w.t1.id, note: "a" },
            { paymentId: w.t1.id, note: "b" },
          ],
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call("update_transactions", { changes: [{ paymentId: w.t1.id }] }))
        .isError,
    ).toBe(true);
  });
});

describe("mcp tools: accounts and balances", () => {
  useTestDB();

  it("lists accounts without IBANs and shows balances", async () => {
    const { w, ok } = await setup();
    const accounts = await ok("list_accounts");
    expect((accounts.items as Rows).map((a) => a.name)).toEqual([
      "Checking",
      "Savings",
    ]);
    expect(JSON.stringify(accounts)).not.toContain(w.bAccount.id);
    expect(JSON.stringify(accounts)).not.toMatch(/iban/i);

    const balances = await ok("get_balances");
    const byName = Object.fromEntries(
      (balances.accounts as Rows).map((a) => [a.name, a]),
    );
    expect(byName.Checking).toMatchObject({
      balance: "-115.50",
      currency: "CHF",
    });
    expect(byName.Savings).toMatchObject({ balance: "-12.00" });
    expect(balances.totals).toEqual([
      { currency: "CHF", balance: "-127.50", accountCount: 2 },
    ]);
  });

  it("shows the net worth per currency", async () => {
    const { ok, call } = await setup();
    const nw = await ok("get_net_worth", { step: "month" });
    const series = nw.series as { currency: string; points: Rows }[];
    expect(series).toHaveLength(1);
    expect(series[0]!.currency).toBe("CHF");
    expect(series[0]!.points.at(-1)).toMatchObject({ amount: "-127.50" });
    expect(
      (await call("get_net_worth", { from: "2026-12-01", to: "2026-01-01" }))
        .isError,
    ).toBe(true);
  });
});

describe("mcp tools: categories and rules", () => {
  useTestDB();

  it("lists categories without another user's", async () => {
    const { w, ok } = await setup();
    const cats = await ok("list_categories");
    expect((cats.items as Rows).map((c) => c.name)).toEqual(["Food", "Rent"]);
    expect(JSON.stringify(cats)).not.toContain(w.bFood.id);
  });

  it("creates, updates and deletes a category, each recorded as this connection", async () => {
    const { w, info, ok, call } = await setup();
    const created = await ok("create_category", {
      name: "Travel",
      kind: "expense",
      color: "#336699",
    });
    expect(created).toMatchObject({ name: "Travel", kind: "expense" });
    const id = created.id as string;
    const child = await ok("create_category", {
      name: "Trains",
      kind: "expense",
      parentId: id,
    });
    expect(child.parentId).toBe(id);
    expect(
      await ok("update_category", { categoryId: id, name: "Trips" }),
    ).toMatchObject({ name: "Trips", kind: "expense" });
    expect(
      (await call("create_category", { name: "Trips", kind: "expense" }))
        .isError,
    ).toBe(true);
    expect(await ok("delete_category", { categoryId: id })).toEqual({
      deleted: true,
      categoryId: id,
    });
    expect(
      (await call("update_category", { categoryId: w.bFood.id, name: "x" }))
        .isError,
    ).toBe(true);
    const log = await listChanges(w.a.id, { tokenId: info.id });
    expect(log.items.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "category.create",
        "category.update",
        "category.delete",
      ]),
    );
  });

  it("manages rules and applies them to uncategorized payments, which can be reverted", async () => {
    const { w, info, ok, call } = await setup();
    const rule = await ok("create_category_rule", {
      categoryId: w.food.id,
      counterpartyContains: "kiosk",
    });
    expect((await ok("list_category_rules")).items).toEqual([
      expect.objectContaining({
        id: rule.id,
        categoryId: w.food.id,
        categoryName: "Food",
        counterpartyContains: "kiosk",
        priority: 100,
      }),
    ]);
    await ok("update_category_rule", {
      ruleId: rule.id,
      priority: 5,
      descriptionContains: "snack",
    });
    expect((await ok("list_category_rules")).items).toEqual([
      expect.objectContaining({
        priority: 5,
        counterpartyContains: "kiosk",
        descriptionContains: "snack",
      }),
    ]);
    expect(
      (await call("create_category_rule", { categoryId: w.food.id })).isError,
    ).toBe(true);

    expect(await ok("apply_category_rules")).toEqual({
      scanned: 2,
      categorized: 1,
    });
    expect(await ok("get_transaction", { paymentId: w.t4.id })).toMatchObject({
      categoryId: w.food.id,
    });

    const applied = await ok("list_changes", { entityType: "category_rule" });
    const entry = (applied.items as Rows).find(
      (e) => e.action === "category_rule.apply",
    )!;
    expect(entry.revertible).toBe(true);
    await ok("revert_change", { changeId: entry.id });
    expect(await ok("get_transaction", { paymentId: w.t4.id })).toMatchObject({
      categoryId: null,
    });

    expect(await ok("delete_category_rule", { ruleId: rule.id })).toEqual({
      deleted: true,
      ruleId: rule.id,
    });
    const log = await listChanges(w.a.id, { tokenId: info.id });
    expect(log.items.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "category_rule.create",
        "category_rule.update",
        "category_rule.apply",
        "category_rule.delete",
      ]),
    );
  });
});

describe("mcp tools: reports", () => {
  useTestDB();

  it("answers budgets with spending per category", async () => {
    const { w, ok } = await setup();
    const { createBudget } = await import("$lib/server/categories");
    await createBudget(w.a.id, {
      categoryId: w.food.id,
      currency: "CHF",
      amount: minor(10000),
    });
    const report = await ok("get_budgets", { month: "2026-03" });
    expect(report).toMatchObject({ month: "2026-03" });
    const chf = (report.currencies as Rows)[0] as Record<string, unknown>;
    expect(chf).toMatchObject({ currency: "CHF", totalBudget: "100.00" });
    expect(chf.budgets).toEqual([
      expect.objectContaining({
        categoryId: w.food.id,
        budget: "100.00",
        spent: "17.50",
        remaining: "82.50",
        over: false,
      }),
    ]);
  });

  it("lists recurring payments (none yet)", async () => {
    const { ok } = await setup();
    expect(await ok("list_recurring_payments")).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("projects the forecast from open bills and lists planned items", async () => {
    const { w, ok } = await setup();
    const { createPlannedItem } = await import("$lib/server/forecast");
    await createPlannedItem(w.a.id, {
      accountId: w.checking.id,
      date: "2026-12-05",
      direction: "expense",
      amount: "20.00",
      currency: null,
      label: "Gift",
    });
    const planned = await ok("list_planned_items");
    expect(planned.items).toEqual([
      expect.objectContaining({ label: "Gift", amount: "-20.00" }),
    ]);
    const forecast = await ok("get_forecast", { days: 90 });
    expect(forecast.accounts).toHaveLength(2);
    expect(forecast).toHaveProperty("unprojectedBills");
  });

  it("reports investments, pillar 3a and taxes", async () => {
    const { ok, call } = await setup();
    expect(await ok("get_investments")).toMatchObject({
      totals: [],
      securities: [],
    });
    expect(await ok("get_pillar3a")).toMatchObject({
      currency: "CHF",
      portfolios: [],
    });
    expect(await ok("list_tax_years")).toEqual({ items: [] });
    expect((await call("get_tax_year", { year: 2025 })).isError).toBe(true);
  });
});

describe("mcp tools: change log", () => {
  useTestDB();

  it("lists only this connection's own changes, with no values", async () => {
    const { w, info, ok } = await setup();
    // A change by the owner in the web UI and one by another token.
    await createBill(w.a.id, {
      kind: "invoice",
      creditorName: "By the owner",
      creditorIban: null,
      amount: minor(100) as never,
      currency: "CHF",
      issueDate: null,
      dueDate: null,
      reference: null,
      referenceType: null,
      message: null,
      invoiceNumber: null,
      expectedAccountId: null,
      notes: null,
      taxYear: null,
    });
    const other = await seedToken(w.a.id, ["bills:write"], { name: "other" });
    const { callTool } = await import("$lib/testing/mcp");
    await callTool(other.token, "create_bill", {
      creditorName: "By another token",
      amount: "1.00",
    });
    await ok("create_bill", { creditorName: "Mine", amount: "2.00" });

    const log = await ok("list_changes");
    const items = log.items as Rows;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: "bill.create",
      entityType: "bill",
      summary: "Mine",
      revertible: true,
      reverted: false,
    });
    expect(JSON.stringify(log)).not.toContain("2.00");
    expect(JSON.stringify(log)).not.toContain("By another token");
    expect(info.id).toBeTruthy();
    expect(
      (await ok("list_changes", { entityType: "category" })).items,
    ).toEqual([]);
  });

  it("reverts one and several of its own changes, and refuses another connection's", async () => {
    const { w, ok, call } = await setup();
    const a = await ok("create_bill", { creditorName: "A", amount: "1.00" });
    const b = await ok("create_bill", { creditorName: "B", amount: "2.00" });
    const entries = (await ok("list_changes")).items as Rows;
    expect(entries).toHaveLength(2);

    await ok("revert_change", { changeId: entries[1]!.id });
    expect((await call("get_bill", { billId: a.id })).isError).toBe(true);

    const result = await ok("revert_changes", {
      changeIds: [entries[0]!.id, entries[1]!.id],
    });
    expect((result.reverted as Rows).length).toBe(1);
    expect(result.stoppedAt).toBeNull();
    expect((await call("get_bill", { billId: b.id })).isError).toBe(true);

    // Another token's change is not found, even for a token with the same scopes and owner.
    const other = await seedToken(w.a.id, ["bills:write"], { name: "other" });
    const { callTool } = await import("$lib/testing/mcp");
    await callTool(other.token, "create_bill", {
      creditorName: "Theirs",
      amount: "3.00",
    });
    const theirs = (await listChanges(w.a.id, { tokenId: other.info.id }))
      .items[0]!;
    const refused = await call("revert_change", { changeId: theirs.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not found/i);
    const refusedBatch = await call("revert_changes", {
      changeIds: [entries[0]!.id, theirs.id],
    });
    expect(refusedBatch.isError).toBe(true);
    expect(
      (await listChanges(w.a.id, { tokenId: other.info.id })).items[0]!
        .revertedAt,
    ).toBeNull();

    // The revert entries belong to this connection too and cannot be reverted again.
    const again = await call("revert_change", { changeId: entries[1]!.id });
    expect(again.isError).toBe(true);
  });

  it("reports why a change cannot be reverted", async () => {
    const { w, ok, call } = await setup();
    const bill = await ok("create_bill", { creditorName: "A", amount: "1.00" });
    const entry = ((await ok("list_changes")).items as Rows)[0]!;
    await ok("update_bill", { billId: bill.id, notes: "later edit" });
    const refused = await call("revert_change", { changeId: entry.id });
    expect(refused.isError).toBe(true);
    expect(refused.text.length).toBeGreaterThan(10);
    expect(w.a.id).toBeTruthy();
  });
});

describe("mcp tools: whoami and listing", () => {
  useTestDB();

  it("describes the connection and its tools", async () => {
    const { w, token, ok } = await setup();
    const me = await ok("whoami");
    expect(me).toMatchObject({
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      connection: { name: "test token", credential: "api_token" },
      restrictions: { accounts: null, categories: null },
      user: { defaultCurrency: "CHF" },
    });
    expect(me.tools).toEqual(await listToolNames(token));
    expect(JSON.stringify(me)).not.toContain(w.b.id);
  });

  it("lists exactly what the scopes allow", async () => {
    const w = await buildWorld();
    const names = async (scopes: (typeof API_SCOPES)[number][]) =>
      listToolNames((await seedToken(w.a.id, scopes)).token);
    expect(await names(["bills:read"])).toEqual([
      "whoami",
      "list_bills",
      "get_bill",
    ]);
    expect(await names(["transactions:write"])).toEqual([
      "whoami",
      "update_transaction",
      "update_transactions",
    ]);
    expect(await names(["bills:read", "transactions:read"])).toEqual(
      expect.arrayContaining([
        "list_match_suggestions",
        "list_payment_candidates",
      ]),
    );
    expect(await names(["bills:read"])).not.toContain("list_match_suggestions");
    expect(await names(["changes:revert"])).toEqual([
      "whoami",
      "list_changes",
      "revert_change",
      "revert_changes",
    ]);
    expect(await names(["links:write"])).toEqual(["whoami"]);
  });

  it("refuses a tool the token lacks the scope for, even when called by name", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ["bills:read"]);
    const r = await rawCallTool(token, "delete_bill", { billId: w.bill1.id });
    expect(r.isError).toBe(true);
    expect(await seedBillCount(w)).toBe(2);
  });
});

async function seedBillCount(w: World): Promise<number> {
  const { listBills } = await import("$lib/server/bills/bills");
  return (await listBills(w.a.id)).length;
}

afterAll(() => {
  // Every registered tool was exercised through the full request path above.
  expect([...called].sort()).toEqual(TOOLS.map((t) => t.name).sort());
  expect(createCategory).toBeTruthy();
});
