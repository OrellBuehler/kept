import { describe, expect, it, vi } from "vitest";
import { runAutoMatching } from "$lib/server/bills/suggestions";
import { getBill, listBills } from "$lib/server/bills/bills";
import { storeDocument } from "$lib/server/bills/documents";
import { createTestUser } from "$lib/testing/auth";
import { billForm } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { createTestEvent, outcome } from "$lib/testing/event";
import { buildBillPdf } from "$lib/testing/fixtures/bills/pdf";
import {
  QRR,
  QR_IBAN,
  buildPayload,
} from "$lib/testing/fixtures/bills/payloads";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { minor } from "$lib/money";
import { load as detailLoad } from "../[id]/+page.server";
import { actions, load } from "./+page.server";

vi.mock("$lib/server/bills/suggestions", async (orig) => {
  const actual = await orig<typeof import("$lib/server/bills/suggestions")>();
  return { ...actual, runAutoMatching: vi.fn(actual.runAutoMatching) };
});
const failMatching = () => {
  vi.mocked(runAutoMatching).mockImplementationOnce(() => {
    throw new Error("boom");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

type User = Awaited<ReturnType<typeof createTestUser>>;

const qrPdf = (amount = "1949.75") =>
  buildBillPdf({
    qrPayload: buildPayload({ amount }),
    paymentPart: { account: QR_IBAN, reference: QRR, amount },
  });

function uploadEvent(user: User, file: File | null) {
  const event = createTestEvent({ user });
  const body = new FormData();
  if (file) body.append("file", file);
  event.request = new Request("http://localhost/bills/new", {
    method: "POST",
    body,
  });
  return event as never;
}
const pdfFile = (bytes: Uint8Array, name = "bill.pdf") =>
  new File([bytes as BlobPart], name, { type: "application/pdf" });

const loadAs = (user: User, query = "") =>
  outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://localhost/bills/new${query}`,
      }) as never,
    ),
  );

describe("new bill page", () => {
  useTestDB();
  useTestStore();

  it("a failing auto-match never fails the save", async () => {
    const u = await createTestUser();
    failMatching();
    const created = await outcome(() =>
      actions.create(createTestEvent({ user: u, form: billForm() }) as never),
    );
    expect(created.type).toBe("redirect");
    expect(listBills(u.id)).toHaveLength(1);
  });

  it("a bill created for an already booked payment is Paid on the next detail load", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
      bookingDate: "2026-09-10",
      reference: QRR,
    });
    const created = await outcome(() =>
      actions.create(
        createTestEvent({
          user: u,
          form: billForm({
            amount: "100.00",
            creditorIban: QR_IBAN,
            reference: QRR,
            referenceType: "QRR",
          }),
        }) as never,
      ),
    );
    expect(created.type).toBe("redirect");
    const [bill] = listBills(u.id);
    const detail = await detailLoad(
      createTestEvent({
        user: u,
        params: { id: bill!.id },
        url: `http://localhost/bills/${bill!.id}`,
      }) as never,
    );
    expect((detail as { bill: { status: string } }).bill.status).toBe("paid");
  });

  it("loads an empty form with the user's accounts", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { name: "Checking" });
    const other = await createTestUser();
    await seedAccount(other.id, { name: "Not mine" });
    expect(await loadAs(u)).toEqual({
      type: "return",
      value: {
        accounts: [{ id: acc.id, name: "Checking", currency: "CHF" }],
        draft: null,
        documentId: null,
        extraction: null,
      },
    });
  });

  it("uploads a QR-bill PDF, redirects and prefills the draft", async () => {
    const u = await createTestUser();
    const pdf = new Uint8Array(await qrPdf());
    const up = await outcome(() =>
      actions.upload(uploadEvent(u, pdfFile(pdf))),
    );
    expect(up.type).toBe("redirect");
    const location = (up as { location: string; status: number }).location;
    expect((up as { status: number }).status).toBe(303);
    expect(location).toMatch(/^\/bills\/new\?document=[0-9a-f-]{36}$/);

    const r = await loadAs(u, location.slice("/bills/new".length));
    const v = (
      r as {
        value: {
          draft: Record<string, string>;
          documentId: string;
          extraction: { source: string; warnings: string[] };
        };
      }
    ).value;
    expect(v.extraction).toEqual({ source: "qr", warnings: [] });
    expect(v.draft).toMatchObject({
      creditorName: "Example Energy Ltd",
      creditorIban: QR_IBAN,
      amount: "1949.75",
      referenceType: "QRR",
      reference: QRR,
    });
    expect(await listBillsCount(u.id)).toBe(0);

    const created = await outcome(() =>
      actions.create(
        createTestEvent({
          user: u,
          form: billForm({
            ...v.draft,
            creditorIban: QR_IBAN,
            reference: QRR,
            referenceType: "QRR",
            documentId: v.documentId,
          }),
        }) as never,
      ),
    );
    expect(created.type).toBe("redirect");
    const [bill] = listBills(u.id);
    expect(created).toMatchObject({
      status: 303,
      location: `/bills/${bill!.id}`,
    });
    expect(bill).toMatchObject({
      documentId: v.documentId,
      extraction: { source: "qr" },
    });
  });

  it("maps upload problems to messages", async () => {
    const u = await createTestUser();
    const fail = async (file: File | null) =>
      outcome(() => actions.upload(uploadEvent(u, file)));
    expect(await fail(null)).toMatchObject({
      type: "fail",
      status: 400,
      data: { action: "upload", errors: { file: ["Choose a PDF file."] } },
    });
    expect(await fail(new File(["hello"], "a.pdf"))).toMatchObject({
      data: { errors: { file: ["That file is not a PDF."] } },
    });
    const locked = await buildBillPdf({ bodyLines: ["x"], password: "pw" });
    expect(await fail(pdfFile(locked))).toMatchObject({
      data: { errors: { file: [expect.stringMatching(/password/)] } },
    });
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.pdf");
    expect(await fail(big)).toMatchObject({
      data: { errors: { file: [expect.stringMatching(/20 MB/)] } },
    });
  });

  it("accepts a 20 MB upload", async () => {
    const u = await createTestUser();
    const bytes = new Uint8Array(20 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
    const r = await outcome(() =>
      actions.upload(uploadEvent(u, pdfFile(bytes))),
    );
    // Stored, but the extraction engine may reject an invalid body: either way no size error.
    expect(JSON.stringify(r)).not.toMatch(/20 MB/);
  });

  it("creates a bill without a document and reports field errors", async () => {
    const u = await createTestUser();
    const bad = await outcome(() =>
      actions.create(
        createTestEvent({
          user: u,
          form: billForm({ amount: "0", creditorName: "", creditorIban: "" }),
        }) as never,
      ),
    );
    expect(bad).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "create",
        errors: {
          amount: [expect.any(String)],
          creditorName: [expect.any(String)],
        },
        values: { amount: "0" },
      },
    });
    const ok = await outcome(() =>
      actions.create(
        createTestEvent({ user: u, form: billForm({ amount: "" }) }) as never,
      ),
    );
    expect(ok.type).toBe("redirect");
    expect(getBill(u.id, listBills(u.id)[0]!.id)).toMatchObject({
      amount: null,
      documentId: null,
      extraction: null,
    });
  });

  it("cannot use another user's document or account", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const doc = await storeDocument(
      a.id,
      await qrPdf(),
      "a.pdf",
      "application/pdf",
    );
    expect(await loadAs(b, `?document=${doc.id}`)).toEqual({
      type: "error",
      status: 404,
    });
    const create = (form: Record<string, string>) =>
      outcome(() =>
        actions.create(
          createTestEvent({ user: b, form: billForm(form) }) as never,
        ),
      );
    expect(await create({ documentId: doc.id })).toEqual({
      type: "error",
      status: 404,
    });
    const foreign = await seedAccount(a.id);
    expect(await create({ expectedAccountId: foreign.id })).toMatchObject({
      type: "fail",
      data: { errors: { expectedAccountId: [expect.any(String)] } },
    });
    expect(listBills(b.id)).toEqual([]);
  });
});

function listBillsCount(userId: string) {
  return Promise.resolve(listBills(userId).length);
}
