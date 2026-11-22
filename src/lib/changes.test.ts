import { describe, expect, it } from "vitest";
import { CHANGE_ACTIONS } from "$lib/server/audit/types";
import { minor } from "$lib/money";
import {
  ACTION_LABELS,
  actionLabel,
  actorText,
  currencyOf,
  diffRows,
  ENTITY_LABELS,
  fieldLabel,
  formatChangeValue,
  humanize,
  revertEffect,
  type FormatContext,
} from "./changes";

const ctx: FormatContext = {
  refs: {
    categories: { c1: "Groceries" },
    accounts: { a1: { name: "Everyday", currency: "CHF" } },
    bills: { b1: { name: "Example Creditor", currency: "EUR" } },
    institutions: {},
    transactions: {},
  },
  amount: (v, c) => `${c} ${(v / 100).toFixed(2)}`,
  date: (iso) => `date:${iso}`,
  dateTime: (ms) => `at:${ms}`,
  iban: (i) => (i === "hidden" ? null : `iban:${i}`),
};

describe("labels", () => {
  it("has a label for every action of the change log and none for unknown ones", () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(
      Object.keys(CHANGE_ACTIONS).sort(),
    );
    for (const label of Object.values(ACTION_LABELS)) {
      expect(label.length).toBeGreaterThan(3);
    }
  });

  it("has a label for every entity type", () => {
    const types = new Set(
      Object.keys(CHANGE_ACTIONS).map((a) => a.split(".")[0]),
    );
    expect([...types].filter((t) => !ENTITY_LABELS[t!])).toEqual([]);
  });

  it("falls back to something readable", () => {
    expect(actionLabel("thing.explode")).toBe("thing.explode");
    expect(fieldLabel("someNewField")).toBe("Some new field");
    expect(humanize("auto_match")).toBe("Auto match");
  });

  it("names the actor", () => {
    expect(actorText({ kind: "web", label: null })).toBe("You (web)");
    expect(actorText({ kind: "mcp", label: "Desk" })).toBe(
      "Assistant (MCP): Desk",
    );
    expect(actorText({ kind: "system", label: null })).toBe("System");
  });

  it("describes what a revert does for each kind of change", () => {
    expect(revertEffect("bill.create", "Bill")).toMatch(/deleted again/);
    expect(revertEffect("bill.delete", "Bill")).toMatch(/restored/);
    expect(revertEffect("bill.update", "Bill")).toMatch(/set back/);
    expect(revertEffect("allocation.auto_match", "Bill payment")).toMatch(
      /deleted again/,
    );
  });
});

describe("formatChangeValue", () => {
  const f = (field: string, v: unknown, currency: string | null = "CHF") =>
    formatChangeValue(field, v, ctx, currency);

  it("formats amounts from minor units with the currency, negative included", () => {
    expect(f("amount", minor(-1250))).toBe("CHF -12.50");
    expect(f("openingBalance", 100000, "EUR")).toBe("EUR 1000.00");
    expect(f("amount", 500, null)).toBe("500 (minor units)");
  });

  it("formats dates, instants, booleans, empty values and shares", () => {
    expect(f("dueDate", "2026-03-01")).toBe("date:2026-03-01");
    expect(f("createdAt", 1000)).toBe("at:1000");
    expect(f("archived", false)).toBe("No");
    expect(f("note", null)).toBe("–");
    expect(f("note", "")).toBe("–");
    expect(f("shareBps", 5000)).toBe("50%");
  });

  it("resolves ids to names and marks deleted records", () => {
    expect(f("categoryId", "c1")).toBe("Groceries");
    expect(f("categoryId", "gone")).toBe("Deleted category");
    expect(f("expectedAccountId", "a1")).toBe("Everyday");
    expect(f("billId", "b1")).toBe("Example Creditor");
  });

  it("respects hidden IBANs and shows enums as words", () => {
    expect(f("creditorIban", "CH93")).toBe("iban:CH93");
    expect(f("creditorIban", "hidden")).toBe("Hidden");
    expect(f("referenceType", "scor_ref")).toBe("Scor ref");
  });

  it("shows long lists as counts and keeps unknown shapes", () => {
    expect(f("transactionIds", { count: 120, truncated: true })).toBe(
      "120 items",
    );
    expect(f("transactionIds", { count: 1, truncated: true })).toBe("1 item");
    expect(f("tags", ["a", "b"])).toBe("a, b");
    expect(f("extra", { x: 1 })).toBe('{"x":1}');
    expect(f("whatever", 7)).toBe("7");
  });
});

describe("diffRows", () => {
  it("takes the currency from the entry or what it points at", () => {
    expect(
      currencyOf([{ currency: "USD" }], { type: "budget", id: "x" }, ctx.refs),
    ).toBe("USD");
    expect(
      currencyOf([{ billId: "b1" }], { type: "allocation", id: "x" }, ctx.refs),
    ).toBe("EUR");
    expect(currencyOf([null], { type: "account", id: "a1" }, ctx.refs)).toBe(
      "CHF",
    );
    expect(
      currencyOf([null], { type: "tax_year", id: "t" }, ctx.refs),
    ).toBeNull();
  });

  it("lists every field of an update with before and after, unknown ones included", () => {
    const rows = diffRows(
      {
        entityType: "bill",
        entityId: "b1",
        before: { amount: 1000, dueDate: null, brandNew: "x" },
        after: { amount: 2000, dueDate: "2026-04-01", brandNew: "y" },
      },
      ctx,
    );
    expect(rows).toEqual([
      {
        field: "amount",
        label: "Amount",
        before: "EUR 10.00",
        after: "EUR 20.00",
      },
      {
        field: "dueDate",
        label: "Due date",
        before: "–",
        after: "date:2026-04-01",
      },
      { field: "brandNew", label: "Brand new", before: "x", after: "y" },
    ]);
  });

  it("shows only the after of a create and only the before of a delete", () => {
    const create = diffRows(
      {
        entityType: "category",
        entityId: "c1",
        before: null,
        after: { name: "A" },
      },
      ctx,
    );
    expect(create).toEqual([
      { field: "name", label: "Name", before: null, after: "A" },
    ]);
    const del = diffRows(
      {
        entityType: "category",
        entityId: "c1",
        before: { name: "A" },
        after: null,
      },
      ctx,
    );
    expect(del).toEqual([
      { field: "name", label: "Name", before: "A", after: null },
    ]);
  });
});
