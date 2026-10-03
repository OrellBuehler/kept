import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  digest,
  evaluateTriggers,
  type BillFact,
  type Facts,
} from "./evaluate";
import { DEFAULT_SETTINGS, type TriggerSettings } from "./types";

const bill = (over: Partial<BillFact> = {}): BillFact => ({
  id: "b1",
  creditorName: "Example Supplier",
  invoiceNumber: null,
  kind: "invoice",
  status: "open",
  remaining: minor(12_550),
  currency: "CHF",
  dueDate: "2026-10-05",
  dueInDays: 2,
  overdue: false,
  ...over,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  today: "2026-10-03",
  month: "2026-10",
  bills: [],
  budgets: [],
  accounts: [],
  ...over,
});

const on = (over: Partial<TriggerSettings>): TriggerSettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

describe("evaluateTriggers", () => {
  it("does nothing when every trigger is off", () => {
    const f = facts({
      bills: [bill(), bill({ id: "b2", overdue: true, dueInDays: -3 })],
    });
    expect(evaluateTriggers(DEFAULT_SETTINGS, f)).toEqual([]);
  });

  it("notifies bills due within the window, with a stable key", () => {
    const events = evaluateTriggers(
      on({ billDueEnabled: true, billDueDays: 3 }),
      facts({
        bills: [
          bill(),
          bill({ id: "far", dueInDays: 4, dueDate: "2026-10-07" }),
          bill({ id: "today", dueInDays: 0, dueDate: "2026-10-03" }),
        ],
      }),
    );
    expect(events.map((e) => e.key)).toEqual([
      "bill-due:b1:2026-10-05",
      "bill-due:today:2026-10-03",
    ]);
    expect(events[0].body).toContain("Example Supplier");
    expect(events[0].body).toContain("125.50");
    expect(events[0].body).toContain("in 2 days");
    expect(events[1].body).toContain("today");
  });

  it("notifies overdue bills and never calls them due soon", () => {
    const late = bill({
      id: "late",
      overdue: true,
      dueInDays: -1,
      dueDate: "2026-10-02",
    });
    const both = evaluateTriggers(
      on({ billDueEnabled: true, billOverdueEnabled: true }),
      facts({ bills: [late] }),
    );
    expect(both.map((e) => e.key)).toEqual(["bill-overdue:late:2026-10-02"]);
    expect(both[0].body).toContain("1 day ago");
    expect(
      evaluateTriggers(on({ billDueEnabled: true }), facts({ bills: [late] })),
    ).toEqual([]);
  });

  it("ignores paid, cancelled, undated and credit-note bills", () => {
    const events = evaluateTriggers(
      on({ billDueEnabled: true, billOverdueEnabled: true }),
      facts({
        bills: [
          bill({ id: "paid", status: "paid" }),
          bill({ id: "cancelled", status: "cancelled" }),
          bill({ id: "undated", dueDate: null, dueInDays: null }),
          bill({ id: "credit", kind: "credit_note" }),
        ],
      }),
    );
    expect(events).toEqual([]);
  });

  it("handles open-amount bills without an amount in the text", () => {
    const [e] = evaluateTriggers(
      on({ billDueEnabled: true }),
      facts({ bills: [bill({ remaining: null })] }),
    );
    expect(e.body.startsWith("Example Supplier is due")).toBe(true);
  });

  it("notifies budgets at the configured percentage", () => {
    const row = (budgetId: string, spent: number) => ({
      budgetId,
      categoryName: "Groceries",
      currency: "CHF",
      budget: minor(50_000),
      spent: minor(spent),
    });
    const f = facts({
      budgets: [row("a", 39_999), row("b", 40_000), row("c", 50_001)],
    });
    const at80 = evaluateTriggers(
      on({ budgetEnabled: true, budgetPercent: 80 }),
      f,
    );
    expect(at80.map((e) => e.key)).toEqual([
      "budget:b:2026-10:80",
      "budget:c:2026-10:80",
    ]);
    expect(at80[0].title).toBe("Budget nearly used");
    expect(at80[1].title).toBe("Budget exceeded");
    const at100 = evaluateTriggers(on({ budgetEnabled: true }), f);
    expect(at100.map((e) => e.key)).toEqual(["budget:c:2026-10:100"]);
  });

  it("notifies accounts not imported for N days, keyed by the last import", () => {
    const f = facts({
      accounts: [
        { id: "a1", name: "Main", lastImportDate: "2026-09-19" },
        { id: "a2", name: "Savings", lastImportDate: "2026-09-20" },
      ],
    });
    const events = evaluateTriggers(
      on({ staleImportEnabled: true, staleImportDays: 14 }),
      f,
    );
    expect(events.map((e) => e.key)).toEqual(["stale-import:a1:2026-09-19"]);
    expect(events[0].body).toContain("14 days ago");
  });
});

describe("digest", () => {
  it("is null without events, the event itself for one, a list for several", () => {
    expect(digest([])).toBeNull();
    expect(digest([{ key: "k", title: "T", body: "B" }])).toEqual({
      title: "T",
      body: "B",
    });
    const many = digest([
      { key: "1", title: "A", body: "x" },
      { key: "2", title: "B", body: "y" },
    ]);
    expect(many?.title).toBe("Kept: 2 notifications");
    expect(many?.body).toBe("A: x\nB: y");
  });
});
