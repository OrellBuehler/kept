import { describe, expect, it } from "vitest";
import { formatIban } from "$lib/iban";
import {
  BAD_IBAN_CHECK,
  BAD_QRR_CHECK,
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
  EXAMPLE_SCOR,
} from "$lib/testing/fixtures/bill-identifiers";
import { formatReference } from "$lib/references";
import { extractFromText } from "./text-extract";

describe("extractFromText", () => {
  it("finds nothing in unrelated text", () => {
    const result = extractFromText("Dear Sir, meeting on 12 May at 14.30.");
    expect(result.confidence).toBe("none");
    expect(Object.values(result.fields).every((v) => v === null)).toBe(true);
  });

  it("reads a German payment part", () => {
    const text = [
      "Zahlteil",
      "Konto / Zahlbar an",
      formatIban(EXAMPLE_IBAN_OTHER),
      "Example Energy Ltd",
      "Samplestrasse 1",
      "8000 Zürich",
      "Referenz",
      formatReference(EXAMPLE_QRR),
      "Währung Betrag",
      "CHF 1 949.75",
    ].join("\n");
    const { fields, confidence } = extractFromText(text);
    expect(confidence).toBe("medium");
    expect(fields).toMatchObject({
      creditorIban: EXAMPLE_IBAN_OTHER,
      creditorName: "Example Energy Ltd",
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      amount: 194975,
      currency: "CHF",
    });
  });

  it("never takes a line with an amount, currency or amount keyword as creditor", () => {
    for (const line of [
      "Total CHF 89.90",
      "CHF 89.90",
      "Summe 89.90",
      "Amount due",
      "Betrag",
      "EUR",
    ]) {
      const text = ["Zahlbar an:", formatIban(EXAMPLE_IBAN), line].join("\n");
      expect(extractFromText(text).fields.creditorName).toBeNull();
    }
  });

  it("reads French, Italian and English labels", () => {
    expect(
      extractFromText("Montant à payer: 1'234.50 EUR\nÉchéance: 05.06.2031")
        .fields,
    ).toMatchObject({ amount: 123450, currency: "EUR", dueDate: "2031-06-05" });
    expect(
      extractFromText("Importo CHF 99,90\nDa pagare entro il 1.2.31").fields,
    ).toMatchObject({ amount: 9990, currency: "CHF", dueDate: "2031-02-01" });
    expect(
      extractFromText(
        "Amount due: EUR 1.234,56\nDue date: 2031-07-09\nInvoice No. A-1234",
      ).fields,
    ).toMatchObject({
      amount: 123456,
      currency: "EUR",
      dueDate: "2031-07-09",
      invoiceNumber: "A-1234",
    });
    expect(extractFromText("Payable by 31/12/2031").fields.dueDate).toBe(
      "2031-12-31",
    );
  });

  it("uses the last labelled amount", () => {
    const text = "Zwischensumme CHF 100.00\nTotal CHF 108.10";
    expect(extractFromText(text).fields.amount).toBe(10810);
  });

  it("rejects invalid references, IBANs and impossible dates", () => {
    const { fields } = extractFromText(
      `IBAN ${formatIban(BAD_IBAN_CHECK)}\nRef ${formatReference(BAD_QRR_CHECK)}\nFällig 31.02.2031`,
    );
    expect(fields.creditorIban).toBeNull();
    expect(fields.reference).toBeNull();
    expect(fields.dueDate).toBeNull();
  });

  it("finds a SCOR reference and an IBAN without spaces", () => {
    const { fields } = extractFromText(
      `${EXAMPLE_IBAN} Referenz ${formatReference(EXAMPLE_SCOR)} Zahlbar bis 01.01.2032`,
    );
    expect(fields).toMatchObject({
      creditorIban: EXAMPLE_IBAN,
      reference: EXAMPLE_SCOR,
      referenceType: "SCOR",
      dueDate: "2032-01-01",
    });
  });

  it("ignores amounts without two decimals", () => {
    expect(extractFromText("Betrag 2024").fields.amount).toBeNull();
  });

  it("does not read a date after a total label as an amount", () => {
    expect(extractFromText("Total 12.03.2024").fields.amount).toBeNull();
    expect(extractFromText("Betrag 12.03.24 CHF 45.50").fields).toMatchObject({
      amount: 4550,
      currency: "CHF",
    });
    expect(extractFromText("Betrag 1.234,50.").fields.amount).toBe(123450);
  });

  it("prefers specific total labels over later generic ones", () => {
    const text = [
      "Rechnungsbetrag CHF 108.10",
      "Total Positionen 100.00",
      "Betrag CHF 50.00",
    ].join("\n");
    expect(extractFromText(text).fields.amount).toBe(10810);
    expect(
      extractFromText("Importo totale EUR 70.00\nTotale parziale 10.00").fields,
    ).toMatchObject({ amount: 7000, currency: "EUR" });
  });

  it("prefers matches with a currency and skips VAT lines", () => {
    expect(extractFromText("Total 99.00\nTotal CHF 108.10").fields.amount).toBe(
      10810,
    );
    const vat = "Total CHF 108.10\nTotal MWST 8.10\nMWST Betrag 8.10";
    expect(extractFromText(vat).fields.amount).toBe(10810);
    expect(extractFromText("Total TVA 8.10").fields.amount).toBeNull();
  });

  it("only looks at the first two million characters", () => {
    const filler = "x ".repeat(1_100_000);
    expect(extractFromText(filler + "Total CHF 5.00").fields.amount).toBeNull();
  });
});
