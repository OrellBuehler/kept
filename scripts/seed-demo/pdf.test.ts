import { describe, expect, it } from "vitest";
import { hasPdfMagic } from "../../src/lib/server/bills/documents";
import { extractBillFromPdf } from "../../src/lib/server/bills/pdf-extract";
import { buildInvoicePdf } from "./pdf";

const invoice = {
  creditor: "Example Energy Utility",
  invoiceNumber: "EEU-2026-10",
  issueDate: "2026-10-12",
  dueDate: "2026-11-11",
  amount: "101.57",
  currency: "CHF",
  reference: "RF292026101212",
  message: "Electricity (quarterly) \\ (test)",
};

describe("buildInvoicePdf", () => {
  it("writes a PDF the server accepts as a document", () => {
    const bytes = buildInvoicePdf(invoice);
    expect(hasPdfMagic(bytes)).toBe(true);
    expect(new TextDecoder().decode(bytes.slice(-6)).trim()).toBe("%%EOF");
    expect(bytes.byteLength).toBeLessThan(2_000);
  });

  it("points every cross-reference entry at its object", () => {
    const text = new TextDecoder("latin1").decode(buildInvoicePdf(invoice));
    const table = text.slice(text.indexOf("xref\n"));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => {
      expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true);
    });
    expect(Number(/startxref\n(\d+)/.exec(text)![1])).toBe(
      text.indexOf("xref\n"),
    );
  });

  it("differs per invoice, so the server stores each one as its own document", () => {
    const other = buildInvoicePdf({ ...invoice, invoiceNumber: "EEU-2027-01" });
    expect(other).not.toEqual(buildInvoicePdf(invoice));
  });

  it("is readable by the server's PDF reader", async () => {
    const result = await extractBillFromPdf(buildInvoicePdf(invoice));
    expect(result.source).toBe("text");
    expect(result.fields).toMatchObject({
      amount: 10_157,
      reference: invoice.reference,
      dueDate: invoice.dueDate,
    });
  });
});
