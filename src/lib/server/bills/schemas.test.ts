import { describe, expect, it } from "vitest";
import { parseForm } from "$lib/server/forms";
import {
  BAD_IBAN_CHECK,
  BAD_QRR_CHECK,
  BAD_SCOR_CHECK,
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
  EXAMPLE_SCOR,
} from "$lib/testing/fixtures/bill-identifiers";
import { billForm } from "$lib/testing/bills";
import { billInputSchema } from "./schemas";

function parse(over: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(billForm(over))) form.append(k, v);
  return parseForm(billInputSchema, form);
}
const errorsOf = (over: Record<string, string>) => {
  const r = parse(over);
  return r.ok ? {} : r.errors;
};

describe("billInputSchema", () => {
  it("parses a plain bill", () => {
    const r = parse({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        kind: "invoice",
        creditorIban: EXAMPLE_IBAN,
        amount: 10000,
        currency: "CHF",
        reference: null,
        referenceType: null,
        taxYear: null,
      });
    }
  });

  it("normalizes the IBAN and currency and parses the amount by exponent", () => {
    const r = parse({
      creditorIban: "ch93 0076 2011 6238 5295 7",
      currency: "jpy",
      amount: "1'200",
    });
    expect(r.ok && r.data).toMatchObject({
      creditorIban: EXAMPLE_IBAN,
      currency: "JPY",
      amount: 1200,
    });
  });

  it("allows an open amount but rejects zero and negative amounts", () => {
    const open = parse({ amount: "" });
    expect(open.ok && open.data.amount).toBeNull();
    expect(errorsOf({ amount: "0" }).amount).toBeDefined();
    expect(errorsOf({ amount: "0.00" }).amount?.[0]).toMatch(
      /greater than zero/,
    );
    expect(errorsOf({ amount: "-5" }).amount).toBeDefined();
    expect(errorsOf({ amount: "12.345" }).amount).toBeDefined();
    expect(errorsOf({ amount: "abc" }).amount).toBeDefined();
  });

  it("needs a creditor name unless an IBAN is given", () => {
    expect(
      errorsOf({ creditorName: "", creditorIban: "" }).creditorName,
    ).toBeDefined();
    expect(errorsOf({ creditorName: "" }).creditorName).toBeUndefined();
    expect(errorsOf({ creditorIban: "" }).creditorName).toBeUndefined();
  });

  it("rejects an invalid IBAN and currency", () => {
    expect(
      errorsOf({ creditorIban: BAD_IBAN_CHECK }).creditorIban,
    ).toBeDefined();
    expect(errorsOf({ currency: "CH" }).currency).toBeDefined();
  });

  it("validates QRR and SCOR references against their type", () => {
    const qr = { creditorIban: EXAMPLE_IBAN_OTHER };
    expect(
      errorsOf({ ...qr, reference: EXAMPLE_QRR, referenceType: "QRR" }),
    ).toEqual({});
    expect(
      errorsOf({ ...qr, reference: BAD_QRR_CHECK, referenceType: "QRR" })
        .reference,
    ).toBeDefined();
    expect(
      errorsOf({ reference: EXAMPLE_SCOR, referenceType: "SCOR" }),
    ).toEqual({});
    expect(
      errorsOf({ reference: BAD_SCOR_CHECK, referenceType: "SCOR" }).reference,
    ).toBeDefined();
    expect(
      errorsOf({ reference: EXAMPLE_QRR, referenceType: "SCOR" }).reference,
    ).toBeDefined();
  });

  it("infers the reference type and normalizes spaces", () => {
    const scor = parse({ reference: "rf18 5390 0754 7034" });
    expect(scor.ok && scor.data).toMatchObject({
      reference: EXAMPLE_SCOR,
      referenceType: "SCOR",
    });
    const qrr = parse({
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: "21 00000 00003 13947 14300 09017",
    });
    expect(qrr.ok && qrr.data).toMatchObject({
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    expect(errorsOf({ reference: "hello" }).reference).toBeDefined();
  });

  it("requires a reference for QRR/SCOR and forbids one for NON", () => {
    expect(errorsOf({ referenceType: "SCOR" }).reference).toBeDefined();
    expect(errorsOf({ referenceType: "NON" })).toEqual({});
    expect(
      errorsOf({ referenceType: "NON", reference: EXAMPLE_SCOR }).reference,
    ).toBeDefined();
  });

  it("enforces QR-IBAN <=> QRR", () => {
    expect(
      errorsOf({ creditorIban: EXAMPLE_IBAN_OTHER }).reference?.[0],
    ).toMatch(/QR-IBAN/);
    expect(
      errorsOf({
        creditorIban: EXAMPLE_IBAN_OTHER,
        reference: EXAMPLE_SCOR,
        referenceType: "SCOR",
      }).reference,
    ).toBeDefined();
    expect(
      errorsOf({
        creditorIban: EXAMPLE_IBAN,
        reference: EXAMPLE_QRR,
        referenceType: "QRR",
      }).referenceType,
    ).toBeDefined();
  });

  it("checks dates, the due/issue order and the tax year", () => {
    expect(errorsOf({ dueDate: "2026-02-30" }).dueDate).toBeDefined();
    expect(
      errorsOf({ issueDate: "2026-10-01", dueDate: "2026-09-01" }).dueDate,
    ).toBeDefined();
    expect(errorsOf({ taxYear: "26" }).taxYear).toBeDefined();
    const ok = parse({ taxYear: "2025", issueDate: "", dueDate: "" });
    expect(ok.ok && ok.data).toMatchObject({
      taxYear: 2025,
      issueDate: null,
      dueDate: null,
    });
  });

  it("defaults the kind and rejects unknown kinds", () => {
    const r = parse({ kind: "" });
    expect(r.ok && r.data.kind).toBe("invoice");
    expect(errorsOf({ kind: "donation" }).kind).toBeDefined();
    const c = parse({ kind: "credit_note" });
    expect(c.ok && c.data.kind).toBe("credit_note");
  });
});
