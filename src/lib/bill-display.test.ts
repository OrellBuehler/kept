import { formatIban } from "$lib/iban";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { describe, expect, it } from "vitest";
import {
  dueHint,
  emptyBillValues,
  formatReference,
  mergeRereadDraft,
} from "./bill-display";

describe("dueHint", () => {
  const base = { overdue: false, status: "open" as const };
  it("describes overdue bills", () => {
    expect(dueHint({ ...base, overdue: true, dueInDays: -1 })).toBe(
      "1 day overdue",
    );
    expect(dueHint({ ...base, overdue: true, dueInDays: -12 })).toBe(
      "12 days overdue",
    );
  });
  it("describes upcoming due dates", () => {
    expect(dueHint({ ...base, dueInDays: 0 })).toBe("Due today");
    expect(dueHint({ ...base, dueInDays: 1 })).toBe("Due tomorrow");
    expect(dueHint({ ...base, dueInDays: 9 })).toBe("Due in 9 days");
  });
  it("stays quiet for settled bills and missing dates", () => {
    expect(dueHint({ ...base, status: "paid", dueInDays: 4 })).toBeNull();
    expect(dueHint({ ...base, dueInDays: null })).toBeNull();
  });
});

describe("formatReference", () => {
  it("groups a 27 digit QR reference", () => {
    expect(formatReference("000000000000000000000000000")).toBe(
      "00 00000 00000 00000 00000 00000",
    );
  });
  it("groups a creditor reference in fours", () => {
    expect(formatReference("rf12 abcd efgh")).toBe("RF12 ABCD EFGH");
  });
  it("leaves anything else alone", () => {
    expect(formatReference(" abc ")).toBe("abc");
  });
});

describe("mergeRereadDraft", () => {
  const base = {
    ...emptyBillValues(),
    kind: "credit_note" as const,
    creditorName: "Stored",
    notes: "keep me",
    expectedAccountId: "acc",
    taxYear: "2025",
    dueDate: "2026-01-01",
  };
  const draft = {
    kind: "invoice" as const,
    creditorName: "From PDF",
    dueDate: "",
    currency: "EUR",
    amount: "12.50",
    creditorIban: EXAMPLE_IBAN.toLowerCase(),
  };

  it("never changes kind and keeps non-PDF fields", () => {
    const out = mergeRereadDraft(base, draft, {
      source: "qr",
      hasAllocations: false,
    });
    expect(out.kind).toBe("credit_note");
    expect(out.notes).toBe("keep me");
    expect(out.expectedAccountId).toBe("acc");
    expect(out.taxYear).toBe("2025");
  });
  it("overlays found fields and keeps stored ones for empty values", () => {
    const out = mergeRereadDraft(base, draft, {
      source: "qr",
      hasAllocations: false,
    });
    expect(out.creditorName).toBe("From PDF");
    expect(out.amount).toBe("12.50");
    expect(out.dueDate).toBe("2026-01-01");
    expect(out.creditorIban).toBe(formatIban(EXAMPLE_IBAN));
  });
  it("takes the currency only from a QR code and without payments", () => {
    const qr = { source: "qr" as const, hasAllocations: false };
    expect(mergeRereadDraft(base, draft, qr).currency).toBe("EUR");
    expect(
      mergeRereadDraft(base, draft, { ...qr, hasAllocations: true }).currency,
    ).toBe("CHF");
    expect(
      mergeRereadDraft(base, draft, { ...qr, source: "text" }).currency,
    ).toBe("CHF");
  });
});
