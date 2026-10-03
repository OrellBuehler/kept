import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  BILL_LIST_STATUSES,
  filterBills,
  paginateBills,
  parseBillListQuery,
} from "./list";
import type { BillWithStatus } from "./status";
import {
  IBAN_CH_SPACED,
  SCOR,
  SCOR_SPACED,
} from "$lib/testing/fixtures/values";

let seq = 0;
function view(over: Partial<BillWithStatus> = {}): BillWithStatus {
  seq += 1;
  return {
    id: `b${String(seq).padStart(4, "0")}`,
    kind: "invoice",
    creditorName: null,
    creditorIban: null,
    amount: minor(10000),
    currency: "CHF",
    issueDate: null,
    dueDate: null,
    reference: null,
    referenceType: null,
    message: null,
    invoiceNumber: null,
    cancelled: false,
    documentId: null,
    expectedAccountId: null,
    notes: null,
    taxYear: null,
    externalSource: null,
    externalRef: null,
    externalUrl: null,
    extraction: null,
    createdAt: 1000,
    updatedAt: 1000,
    status: "open",
    settled: minor(0),
    remaining: minor(10000),
    overdue: false,
    dueInDays: null,
    lastPaymentDate: null,
    allocationCount: 0,
    ...over,
  };
}

const ids = (list: readonly BillWithStatus[]) => list.map((v) => v.id);
const params = (s: string) => new URLSearchParams(s);

describe("parseBillListQuery", () => {
  it("defaults", () => {
    expect(parseBillListQuery(params(""))).toEqual({
      q: "",
      status: "all",
      page: 1,
    });
  });

  it("parses valid values and trims q", () => {
    expect(
      parseBillListQuery(params("q=%20%20acme%20&status=overdue&page=3")),
    ).toEqual({ q: "acme", status: "overdue", page: 3 });
  });

  it("accepts every listed status", () => {
    for (const s of BILL_LIST_STATUSES) {
      expect(parseBillListQuery(params(`status=${s}`)).status).toBe(s);
    }
  });

  it("falls back to defaults on invalid values", () => {
    for (const bad of ["0", "-2", "abc", "1.5", "", "9999999"]) {
      expect(parseBillListQuery(params(`page=${bad}`)).page).toBe(1);
    }
    expect(parseBillListQuery(params("status=bogus")).status).toBe("all");
    expect(parseBillListQuery(params("status=")).status).toBe("all");
  });

  it("truncates q to 200 characters", () => {
    const q = parseBillListQuery(params(`q=${"x".repeat(500)}`)).q;
    expect(q).toHaveLength(200);
  });
});

describe("filterBills status", () => {
  const open = view({ status: "open" });
  const partial = view({ status: "partially_paid" });
  const overdueOpen = view({ status: "open", overdue: true });
  const overduePartial = view({ status: "partially_paid", overdue: true });
  const paid = view({ status: "paid" });
  const credit = view({ status: "credit_due", kind: "credit_note" });
  const overpaidInvoice = view({ status: "overpaid", kind: "invoice" });
  const overpaidCredit = view({ status: "overpaid", kind: "credit_note" });
  const cancelled = view({ status: "cancelled", cancelled: true });
  const all = [
    open,
    partial,
    overdueOpen,
    overduePartial,
    paid,
    credit,
    overpaidInvoice,
    overpaidCredit,
    cancelled,
  ];
  const f = (status: Parameters<typeof filterBills>[1]["status"]) =>
    new Set(ids(filterBills(all, { q: "", status })));

  it("all returns everything", () => {
    expect(f("all").size).toBe(all.length);
  });
  it("open excludes overdue", () => {
    expect(f("open")).toEqual(new Set(ids([open, partial])));
  });
  it("overdue", () => {
    expect(f("overdue")).toEqual(new Set(ids([overdueOpen, overduePartial])));
  });
  it("paid", () => {
    expect(f("paid")).toEqual(new Set(ids([paid])));
  });
  it("refund", () => {
    expect(f("refund")).toEqual(new Set(ids([credit, overpaidInvoice])));
  });
  it("cancelled", () => {
    expect(f("cancelled")).toEqual(new Set(ids([cancelled])));
  });
});

describe("filterBills text", () => {
  const byName = view({ creditorName: "Alpine Power Ltd" });
  const byInvoice = view({ invoiceNumber: "INV-2026-0042" });
  const byMessage = view({ message: "Quarterly subscription" });
  const byNotes = view({ notes: "Call the helpdesk" });
  const byRef = view({ reference: SCOR_SPACED });
  const byIban = view({ creditorIban: IBAN_CH_SPACED });
  const byAmount = view({ amount: minor(12050) });
  const none = view({ amount: null });
  const all = [
    byName,
    byInvoice,
    byMessage,
    byNotes,
    byRef,
    byIban,
    byAmount,
    none,
  ];
  const q = (text: string) => ids(filterBills(all, { q: text, status: "all" }));

  it("empty query matches everything", () => {
    expect(q("")).toHaveLength(all.length);
    expect(q("   ")).toHaveLength(all.length);
  });
  it("creditor name, case-insensitive", () => {
    expect(q("ALPINE power")).toEqual([byName.id]);
  });
  it("invoice number", () => {
    expect(q("inv-2026-0042")).toEqual([byInvoice.id]);
  });
  it("message", () => {
    expect(q("subscription")).toEqual([byMessage.id]);
  });
  it("notes", () => {
    expect(q("HELPDESK")).toEqual([byNotes.id]);
  });
  it("reference ignores whitespace on both sides", () => {
    expect(q("RF185390")).toEqual([byRef.id]);
    expect(q("rf18 5390 0754")).toEqual([byRef.id]);
    expect(q(SCOR)).toEqual([byRef.id]);
  });
  it("iban ignores whitespace on both sides", () => {
    expect(q("ch9300762011")).toEqual([byIban.id]);
    expect(q("CH93 0076 2011")).toEqual([byIban.id]);
  });
  it("references and ibans need at least four characters", () => {
    expect(q("rf18")).toEqual([byRef.id]);
    expect(q("ch9")).toEqual([]);
  });
  it("exact amount match", () => {
    expect(q("120.50")).toEqual([byAmount.id]);
    expect(q("120,50")).toEqual([byAmount.id]);
    expect(q("120.5")).toEqual([byAmount.id]);
  });
  it("amount is exact, not a prefix", () => {
    expect(q("120")).toEqual([]);
  });
  it("amount with too many decimals is just text", () => {
    expect(q("120.505")).toEqual([]);
  });
  it("empty result", () => {
    expect(q("zzz-nothing")).toEqual([]);
  });
  it("combines with status", () => {
    const paid = view({ creditorName: "Alpine Paid", status: "paid" });
    expect(
      ids(filterBills([byName, paid], { q: "alpine", status: "paid" })),
    ).toEqual([paid.id]);
  });
});

describe("filterBills sort", () => {
  it("orders by due date (or issue date) descending, nulls last", () => {
    const a = view({ dueDate: "2026-03-01" });
    const b = view({ dueDate: "2026-05-01" });
    const c = view({ dueDate: null, issueDate: "2026-04-01" });
    const d = view({ dueDate: null, issueDate: null });
    expect(ids(filterBills([d, a, c, b], { q: "", status: "all" }))).toEqual(
      ids([b, c, a, d]),
    );
  });

  it("ties break by createdAt descending, then id", () => {
    const old = view({ dueDate: "2026-05-01", createdAt: 1 });
    const recent = view({ dueDate: "2026-05-01", createdAt: 9 });
    const x = view({ dueDate: "2026-05-01", createdAt: 5 });
    const y = view({ dueDate: "2026-05-01", createdAt: 5 });
    const expected = ids([recent, x, y, old]);
    expect(
      ids(filterBills([old, y, x, recent], { q: "", status: "all" })),
    ).toEqual(expected);
    expect(
      ids(filterBills([recent, x, old, y], { q: "", status: "all" })),
    ).toEqual(expected);
  });

  it("does not mutate the input", () => {
    const a = view({ dueDate: "2026-01-01" });
    const b = view({ dueDate: "2026-02-01" });
    const input = [a, b];
    filterBills(input, { q: "", status: "all" });
    expect(ids(input)).toEqual(ids([a, b]));
  });
});

describe("paginateBills", () => {
  const list = Array.from({ length: 60 }, () => view());

  it("returns the first page", () => {
    const p = paginateBills(list, 1);
    expect(p).toMatchObject({ total: 60, page: 1, pageSize: 25, pageCount: 3 });
    expect(ids(p.items)).toEqual(ids(list.slice(0, 25)));
  });
  it("returns a partial last page", () => {
    const p = paginateBills(list, 3);
    expect(ids(p.items)).toEqual(ids(list.slice(50)));
  });
  it("clamps page above the range", () => {
    expect(paginateBills(list, 99).page).toBe(3);
  });
  it("clamps page below the range", () => {
    expect(paginateBills(list, 0).page).toBe(1);
    expect(paginateBills(list, -4).page).toBe(1);
  });
  it("empty list has one empty page", () => {
    expect(paginateBills([], 5)).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      pageCount: 1,
    });
  });
  it("honours a custom page size", () => {
    expect(paginateBills(list, 2, 10).items).toHaveLength(10);
    expect(paginateBills(list, 1, 10).pageCount).toBe(6);
  });
});
