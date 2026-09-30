import { describe, expect, it } from "vitest";
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
      "CH44 3199 9123 0008 8901 2",
      "Example Energy Ltd",
      "Samplestrasse 1",
      "8000 Zürich",
      "Referenz",
      "21 00000 00003 13947 14300 09017",
      "Währung Betrag",
      "CHF 1 949.75",
    ].join("\n");
    const { fields, confidence } = extractFromText(text);
    expect(confidence).toBe("medium");
    expect(fields).toMatchObject({
      creditorIban: "CH4431999123000889012",
      creditorName: "Example Energy Ltd",
      reference: "210000000003139471430009017",
      referenceType: "QRR",
      amount: 194975,
      currency: "CHF",
    });
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
      "IBAN CH93 0076 2011 6238 5295 8\nRef 21 00000 00003 13947 14300 09018\nFällig 31.02.2031",
    );
    expect(fields.creditorIban).toBeNull();
    expect(fields.reference).toBeNull();
    expect(fields.dueDate).toBeNull();
  });

  it("finds a SCOR reference and an IBAN without spaces", () => {
    const { fields } = extractFromText(
      "CH9300762011623852957 Referenz RF18 5390 0754 7034 Zahlbar bis 01.01.2032",
    );
    expect(fields).toMatchObject({
      creditorIban: "CH9300762011623852957",
      reference: "RF18539007547034",
      referenceType: "SCOR",
      dueDate: "2032-01-01",
    });
  });

  it("ignores amounts without two decimals", () => {
    expect(extractFromText("Betrag 2024").fields.amount).toBeNull();
  });
});
