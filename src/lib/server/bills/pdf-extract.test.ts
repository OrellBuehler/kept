import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BAD_QRR_CHECK,
  EXAMPLE_IBAN,
  EXAMPLE_SCOR,
} from "$lib/testing/fixtures/bill-identifiers";
import { formatIban } from "$lib/iban";
import { formatReference } from "./references";
import { buildBillPdf } from "$lib/testing/fixtures/bills/pdf";
import {
  PLAIN_IBAN,
  QR_IBAN,
  QRR,
  SCOR,
  buildPayload,
} from "$lib/testing/fixtures/bills/payloads";
import {
  MAX_PDF_BYTES,
  PdfExtractError,
  extractBillFromPdf,
} from "./pdf-extract";

// The zxing WASM binary must come from node_modules, never from the network.
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("network access is not allowed"))),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PdfExtractError) return error.code;
    throw error;
  }
  throw new Error("expected PdfExtractError");
}

describe("extractBillFromPdf with a QR code", () => {
  it("reads a QRR bill", async () => {
    const pdf = await buildBillPdf({
      qrPayload: buildPayload(),
      paymentPart: { account: QR_IBAN, reference: QRR, amount: "1 949.75" },
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.source).toBe("qr");
    expect(result.warnings).toEqual([]);
    expect(result.qr?.creditor.name).toBe("Example Energy Ltd");
    expect(result.fields).toEqual({
      creditorName: "Example Energy Ltd",
      creditorIban: QR_IBAN,
      amount: 194975,
      currency: "CHF",
      reference: QRR,
      referenceType: "QRR",
      dueDate: "2024-04-14",
      invoiceNumber: "INV-0815",
    });
  });

  it("reads SCOR, NON, open-amount and EUR bills", async () => {
    const scor = await extractBillFromPdf(
      await buildBillPdf({
        qrPayload: buildPayload({
          iban: PLAIN_IBAN,
          referenceType: "SCOR",
          reference: SCOR,
          currency: "EUR",
          billInformation: "",
        }),
      }),
    );
    expect(scor.fields).toMatchObject({
      referenceType: "SCOR",
      reference: SCOR,
      currency: "EUR",
      dueDate: null,
    });

    const non = await extractBillFromPdf(
      await buildBillPdf({
        qrPayload: buildPayload({
          iban: PLAIN_IBAN,
          referenceType: "NON",
          reference: "",
          amount: "",
        }),
      }),
    );
    expect(non.source).toBe("qr");
    expect(non.fields).toMatchObject({
      referenceType: "NON",
      reference: null,
      amount: null,
    });
  });

  it("finds the QR code on the last page of a multi-page PDF", async () => {
    const pdf = await buildBillPdf({
      bodyLines: ["Example page one"],
      fillerPages: 3,
      qrPayload: buildPayload(),
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.source).toBe("qr");
    expect(result.fields.creditorIban).toBe(QR_IBAN);
  });

  it("takes the due date from the text when the QR has none", async () => {
    const pdf = await buildBillPdf({
      bodyLines: ["Zahlbar bis 31.12.2030"],
      qrPayload: buildPayload({ billInformation: "" }),
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.source).toBe("qr");
    expect(result.fields.dueDate).toBe("2030-12-31");
  });

  it("reads a small QR code", async () => {
    const pdf = await buildBillPdf({
      qrPayload: buildPayload(),
      qrSize: 90,
    });
    expect((await extractBillFromPdf(pdf)).source).toBe("qr");
  });

  it("warns and falls back to text when the QR payload is invalid", async () => {
    const pdf = await buildBillPdf({
      qrPayload: buildPayload({ reference: BAD_QRR_CHECK }),
      paymentPart: { account: QR_IBAN, amount: "12.50", currency: "CHF" },
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.source).toBe("text");
    expect(result.qr).toBeNull();
    expect(result.warnings.some((w) => w.includes("(reference)"))).toBe(true);
    expect(result.fields.creditorIban).toBe(QR_IBAN);
    expect(result.fields.amount).toBe(1250);
  });

  it("ignores QR codes that are not Swiss QR-bills", async () => {
    const pdf = await buildBillPdf({ qrPayload: "https://example.com/pay" });
    expect((await extractBillFromPdf(pdf)).source).toBe("none");
  });
});

describe("extractBillFromPdf without a QR code", () => {
  it("falls back to the text of the payment part", async () => {
    const pdf = await buildBillPdf({
      bodyLines: ["Rechnung Nr. 2024-77", "Fällig am 15.03.2031"],
      paymentPart: {
        account: formatIban(EXAMPLE_IBAN),
        reference: formatReference(EXAMPLE_SCOR),
        amount: "250.00",
      },
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.source).toBe("text");
    expect(result.qr).toBeNull();
    expect(result.fields).toMatchObject({
      creditorIban: PLAIN_IBAN,
      reference: SCOR,
      referenceType: "SCOR",
      amount: 25000,
      currency: "CHF",
      dueDate: "2031-03-15",
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns source none for a PDF without bill data", async () => {
    const pdf = await buildBillPdf({
      bodyLines: ["Hello, this is a letter about nothing in particular."],
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.source).toBe("none");
    expect(result.qr).toBeNull();
    expect(Object.values(result.fields).every((v) => v === null)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("extractBillFromPdf errors", () => {
  it("rejects non-PDF input", async () => {
    expect(
      await codeOf(extractBillFromPdf(new TextEncoder().encode("hello"))),
    ).toBe("not_pdf");
  });

  it("rejects corrupt PDFs", async () => {
    const corrupt = new TextEncoder().encode("%PDF-1.4\nthis is not a pdf\n");
    expect(await codeOf(extractBillFromPdf(corrupt))).toBe("unreadable");
    const valid = await buildBillPdf({ qrPayload: buildPayload() });
    expect(
      await codeOf(extractBillFromPdf(valid.subarray(0, valid.length >> 2))),
    ).toBe("unreadable");
  });

  it("rejects oversized input before parsing", async () => {
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    expect(await codeOf(extractBillFromPdf(big))).toBe("too_large");
  });

  it("rejects password protected PDFs", async () => {
    const pdf = await buildBillPdf({
      qrPayload: buildPayload(),
      password: "secret",
    });
    expect(await codeOf(extractBillFromPdf(pdf))).toBe("encrypted");
  });

  it("does not modify the caller's buffer", async () => {
    const pdf = await buildBillPdf({ qrPayload: buildPayload() });
    const copy = pdf.slice();
    await extractBillFromPdf(pdf);
    expect(pdf).toEqual(copy);
    expect((await extractBillFromPdf(pdf)).source).toBe("qr");
  });

  it("stops when the time budget is exhausted", async () => {
    const pdf = await buildBillPdf({ qrPayload: buildPayload() });
    const error = await extractBillFromPdf(pdf, { budgetMs: -1 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PdfExtractError);
    expect((error as PdfExtractError).code).toBe("unreadable");
    expect((error as PdfExtractError).message).toMatch(/too long/);
  });

  it("queues concurrent extractions and keeps serving after a failure", async () => {
    const good = await buildBillPdf({ qrPayload: buildPayload() });
    const bad = new TextEncoder().encode("%PDF-1.4\nbroken");
    const results = await Promise.allSettled([
      extractBillFromPdf(good),
      extractBillFromPdf(bad),
      extractBillFromPdf(good),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });

  it("surfaces the zero-amount warning", async () => {
    const pdf = await buildBillPdf({
      qrPayload: buildPayload({ amount: "0.00" }),
    });
    const result = await extractBillFromPdf(pdf);
    expect(result.fields.amount).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/notification only/);
  });
});
