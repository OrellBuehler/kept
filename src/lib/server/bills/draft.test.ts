import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { buildBillPdf } from "$lib/testing/fixtures/bills/pdf";
import {
  QRR,
  QR_IBAN,
  buildPayload,
} from "$lib/testing/fixtures/bills/payloads";
import { parseForm } from "$lib/server/forms";
import { billForm } from "$lib/testing/bills";
import { billFromExtraction } from "./draft";
import { storeDocument } from "./documents";
import { draftForDocument } from "./extraction";
import { extractBillFromPdf } from "./pdf-extract";
import { billInputSchema } from "./schemas";

const qrPdf = (amount = "1949.75") =>
  buildBillPdf({
    qrPayload: buildPayload({ amount }),
    paymentPart: { account: QR_IBAN, reference: QRR, amount },
  });

describe("billFromExtraction", () => {
  it("pre-fills the form values from a QR bill", async () => {
    const { draft, warnings } = billFromExtraction(
      await extractBillFromPdf(await qrPdf()),
    );
    expect(draft).toMatchObject({
      kind: "invoice",
      creditorName: "Example Energy Ltd",
      creditorIban: QR_IBAN,
      amount: "1949.75",
      currency: "CHF",
      reference: QRR,
      referenceType: "QRR",
      invoiceNumber: "INV-0815",
      message: "Invoice 2024-0815",
    });
    expect(warnings).toEqual([]);

    const form = new FormData();
    for (const [k, v] of Object.entries(billForm({ ...draft })))
      form.append(k, v);
    expect(parseForm(billInputSchema, form).ok).toBe(true);
  });

  it("clears a zero amount and warns", async () => {
    const { draft, warnings } = billFromExtraction(
      await extractBillFromPdf(await qrPdf("0.00")),
    );
    expect(draft.amount).toBe("");
    expect(warnings.some((w) => /zero/.test(w))).toBe(true);
  });
});

describe("draftForDocument", () => {
  useTestDB();
  useTestStore();

  it("extracts a stored document and serves the repeat from the cache", async () => {
    const u = await createTestUser();
    const doc = await storeDocument(
      u.id,
      await qrPdf(),
      "bill.pdf",
      "application/pdf",
    );
    const first = await draftForDocument(u.id, doc.id);
    expect(first.extraction.source).toBe("qr");
    expect(first.draft?.creditorIban).toBe(QR_IBAN);
    const second = await draftForDocument(u.id, doc.id);
    expect(second).toEqual(first);
    const fresh = await draftForDocument(u.id, doc.id, { refresh: true });
    expect(fresh).toEqual(first);
  });

  it("reports an unreadable PDF as a warning without a draft", async () => {
    const u = await createTestUser();
    const pdf = await buildBillPdf({ bodyLines: ["x"], password: "secret" });
    const doc = await storeDocument(u.id, pdf, "locked.pdf", "application/pdf");
    const r = await draftForDocument(u.id, doc.id);
    expect(r.draft).toBeNull();
    expect(r.extraction.source).toBe("none");
    expect(r.extraction.warnings[0]).toMatch(/password/);
  });
});
