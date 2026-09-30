import { describe, expect, it } from "vitest";
import {
  BAD_QR_IBAN_CHECK,
  BAD_QRR_CHECK,
  BAD_SCOR_CHECK,
  EXAMPLE_SCOR,
  FOREIGN_IBANS,
} from "$lib/testing/fixtures/bill-identifiers";
import { minor } from "$lib/money";
import {
  PLAIN_IBAN,
  QR_IBAN,
  QRR,
  SCOR,
  buildPayload,
} from "$lib/testing/fixtures/bills/payloads";
import {
  QrBillParseError,
  parseBillInformation,
  parseQrBillPayload,
} from "./qr-bill";
import { formatReference } from "./references";

function fieldOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof QrBillParseError) return e.field;
    throw e;
  }
  throw new Error("expected QrBillParseError");
}

describe("parseQrBillPayload", () => {
  it("parses every field of a QRR bill with structured address", () => {
    const bill = parseQrBillPayload(buildPayload());
    expect(bill).toEqual({
      creditorIban: QR_IBAN,
      creditor: {
        name: "Example Energy Ltd",
        addressLines: ["Samplestrasse 1"],
        postalCode: "8000",
        town: "Zürich",
        country: "CH",
      },
      amount: minor(194975),
      currency: "CHF",
      debtor: {
        name: "Erika Muster",
        addressLines: ["Beispielweg 7"],
        postalCode: "3000",
        town: "Bern",
        country: "CH",
      },
      referenceType: "QRR",
      reference: QRR,
      message: "Invoice 2024-0815",
      billInformation: "//S1/10/INV-0815/11/240315/40/2:10;0:30",
      invoiceNumber: "INV-0815",
      invoiceDate: "2024-03-15",
      dueDate: "2024-04-14",
      alternativeProcedures: [],
      warnings: [],
    });
  });

  it("parses combined (K) addresses", () => {
    const bill = parseQrBillPayload(
      buildPayload({
        addressType: "K",
        line1: "Samplestrasse 1",
        line2: "8000 Zürich",
        postalCode: "",
        town: "",
      }),
    );
    expect(bill.creditor.addressLines).toEqual(["Samplestrasse 1"]);
    expect(bill.creditor.postalCode).toBe("8000");
    expect(bill.creditor.town).toBe("Zürich");
  });

  it("keeps K line 2 as an address line when it has no postal code", () => {
    const bill = parseQrBillPayload(
      buildPayload({
        addressType: "K",
        line1: "Sample Street 1",
        line2: "Zürich",
      }),
    );
    expect(bill.creditor.addressLines).toEqual(["Sample Street 1", "Zürich"]);
    expect(bill.creditor.postalCode).toBeNull();
  });

  it("handles open amounts and no debtor", () => {
    const bill = parseQrBillPayload(buildPayload({ amount: "", debtor: [] }));
    expect(bill.amount).toBeNull();
    expect(bill.debtor).toBeNull();
  });

  it("parses SCOR with a normal IBAN, spaces in the reference", () => {
    const bill = parseQrBillPayload(
      buildPayload({
        iban: PLAIN_IBAN,
        referenceType: "SCOR",
        reference: formatReference(EXAMPLE_SCOR),
        amount: "50.5",
      }),
    );
    expect(bill.referenceType).toBe("SCOR");
    expect(bill.reference).toBe(SCOR);
    expect(bill.amount).toBe(5050);
  });

  it("parses NON without reference", () => {
    const bill = parseQrBillPayload(
      buildPayload({ iban: PLAIN_IBAN, referenceType: "NON", reference: "" }),
    );
    expect(bill.referenceType).toBe("NON");
    expect(bill.reference).toBeNull();
  });

  it("parses EUR", () => {
    expect(parseQrBillPayload(buildPayload({ currency: "EUR" })).currency).toBe(
      "EUR",
    );
  });

  it("accepts CRLF, trailing empty lines, extra whitespace and alternative procedures", () => {
    const payload = buildPayload({
      alternative: ["eBill/B/erika@example.com", "Other/procedure"],
    })
      .split("\n")
      .map((l) => ` ${l} `)
      .join("\r\n");
    const bill = parseQrBillPayload(payload + "\r\n\r\n\r\n");
    expect(bill.creditor.name).toBe("Example Energy Ltd");
    expect(bill.alternativeProcedures).toEqual([
      "eBill/B/erika@example.com",
      "Other/procedure",
    ]);
  });

  it("tolerates a missing billing information line", () => {
    const lines = buildPayload().split("\n");
    const bill = parseQrBillPayload(lines.slice(0, 31).join("\n"));
    expect(bill.billInformation).toBeNull();
    expect(bill.dueDate).toBeNull();
  });

  it("rejects wrong header, version and coding", () => {
    const good = buildPayload();
    expect(fieldOf(() => parseQrBillPayload("XXX" + good.slice(3)))).toBe(
      "header",
    );
    expect(
      fieldOf(() => parseQrBillPayload(good.replace("0200", "0100"))),
    ).toBe("version");
    expect(
      fieldOf(() => parseQrBillPayload(good.replace("0200\n1", "0200\n2"))),
    ).toBe("coding");
    expect(fieldOf(() => parseQrBillPayload(""))).toBe("header");
  });

  it("rejects invalid IBANs", () => {
    expect(
      fieldOf(() =>
        parseQrBillPayload(buildPayload({ iban: BAD_QR_IBAN_CHECK })),
      ),
    ).toBe("creditorIban");
    expect(
      fieldOf(() =>
        parseQrBillPayload(buildPayload({ iban: FOREIGN_IBANS[0] })),
      ),
    ).toBe("creditorIban");
  });

  it("enforces QR-IBAN iff QRR", () => {
    expect(
      fieldOf(() =>
        parseQrBillPayload(
          buildPayload({ referenceType: "NON", reference: "" }),
        ),
      ),
    ).toBe("referenceType");
    expect(
      fieldOf(() => parseQrBillPayload(buildPayload({ iban: PLAIN_IBAN }))),
    ).toBe("referenceType");
  });

  it("rejects invalid check digits", () => {
    expect(
      fieldOf(() =>
        parseQrBillPayload(buildPayload({ reference: BAD_QRR_CHECK })),
      ),
    ).toBe("reference");
    expect(
      fieldOf(() =>
        parseQrBillPayload(
          buildPayload({
            iban: PLAIN_IBAN,
            referenceType: "SCOR",
            reference: BAD_SCOR_CHECK,
          }),
        ),
      ),
    ).toBe("reference");
    expect(
      fieldOf(() =>
        parseQrBillPayload(
          buildPayload({
            iban: PLAIN_IBAN,
            referenceType: "NON",
            reference: QRR,
          }),
        ),
      ),
    ).toBe("reference");
  });

  it("rejects a missing EPD trailer", () => {
    expect(
      fieldOf(() => parseQrBillPayload(buildPayload({ trailer: "" }))),
    ).toBe("trailer");
    expect(
      fieldOf(() => parseQrBillPayload(buildPayload({ trailer: "END" }))),
    ).toBe("trailer");
  });

  it("validates amounts", () => {
    for (const amount of ["-5.00", "1.234", "1000000000.00", "1,50", "abc"]) {
      expect(
        fieldOf(() => parseQrBillPayload(buildPayload({ amount }))),
        amount,
      ).toBe("amount");
    }
    expect(parseQrBillPayload(buildPayload({ amount: "0.01" })).amount).toBe(1);
    expect(
      parseQrBillPayload(buildPayload({ amount: "999999999.99" })).amount,
    ).toBe(99_999_999_999);
  });

  it("accepts a zero amount with a warning", () => {
    const bill = parseQrBillPayload(buildPayload({ amount: "0.00" }));
    expect(bill.amount).toBe(0);
    expect(bill.warnings).toEqual([
      "Zero amount - notification only, nothing to pay",
    ]);
    expect(parseQrBillPayload(buildPayload({ amount: "12" })).amount).toBe(
      1200,
    );
  });

  it("validates currency and creditor address", () => {
    expect(
      fieldOf(() => parseQrBillPayload(buildPayload({ currency: "USD" }))),
    ).toBe("currency");
    expect(
      fieldOf(() => parseQrBillPayload(buildPayload({ addressType: "X" }))),
    ).toBe("creditor.addressType");
    expect(fieldOf(() => parseQrBillPayload(buildPayload({ name: "" })))).toBe(
      "creditor.name",
    );
    expect(fieldOf(() => parseQrBillPayload(buildPayload({ town: "" })))).toBe(
      "creditor.town",
    );
    expect(
      fieldOf(() => parseQrBillPayload(buildPayload({ country: "Schweiz" }))),
    ).toBe("creditor.country");
  });
});

describe("parseBillInformation", () => {
  it("returns nothing for non-S1 content", () => {
    expect(parseBillInformation(null)).toEqual({
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
    });
    expect(parseBillInformation("free text").invoiceNumber).toBeNull();
  });

  it("unescapes slashes in values", () => {
    expect(parseBillInformation("//S1/10/A\\/B\\/7").invoiceNumber).toBe(
      "A/B/7",
    );
  });

  it("derives the due date from the net term only", () => {
    expect(parseBillInformation("//S1/11/240131/40/0:30").dueDate).toBe(
      "2024-03-01",
    );
    expect(parseBillInformation("//S1/11/240131/40/2:10").dueDate).toBeNull();
    expect(parseBillInformation("//S1/40/0:30").dueDate).toBeNull();
  });

  it("ignores service periods and impossible dates", () => {
    expect(parseBillInformation("//S1/11/240101240131").invoiceDate).toBeNull();
    expect(parseBillInformation("//S1/11/240230").invoiceDate).toBeNull();
  });
});
