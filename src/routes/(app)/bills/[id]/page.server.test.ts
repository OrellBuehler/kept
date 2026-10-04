import { describe, expect, it, vi } from "vitest";
import { minor } from "$lib/money";
import { allocate, listBillAllocations } from "$lib/server/bills/allocations";
import { runAutoMatching } from "$lib/server/bills/suggestions";
import { attachDocument, getBill, listBills } from "$lib/server/bills/bills";
import { getDocumentMeta, storeDocument } from "$lib/server/bills/documents";
import { createTestUser } from "$lib/testing/auth";
import { billForm, seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { useTestDocuments } from "$lib/testing/documents";
import { createTestEvent, outcome } from "$lib/testing/event";
import { buildBillPdf } from "$lib/testing/fixtures/bills/pdf";
import {
  QRR,
  QR_IBAN,
  buildPayload,
} from "$lib/testing/fixtures/bills/payloads";
import {
  EXAMPLE_IBAN,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";
import { GET } from "./document/+server";

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
const run = (
  name: keyof typeof actions,
  user: User,
  id: string,
  form: Record<string, string> = {},
) =>
  outcome(() =>
    actions[name]!(createTestEvent({ user, params: { id }, form }) as never),
  );
const loadAs = (user: User, id: string, query = "") =>
  outcome(() =>
    load(
      createTestEvent({
        user,
        params: { id },
        url: `http://localhost/bills/${id}${query}`,
      }) as never,
    ),
  );

const qrPdf = () =>
  buildBillPdf({
    qrPayload: buildPayload(),
    paymentPart: { account: QR_IBAN, reference: QRR, amount: "1949.75" },
  });

describe("bill detail page", () => {
  useTestDB();
  useTestDocuments();

  const refForm = (over: Record<string, string> = {}) =>
    billForm({
      creditorIban: QR_IBAN,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      amount: "100.00",
      ...over,
    });
  const statusOf = async (u: User, id: string) =>
    (
      (await loadAs(u, id)) as unknown as {
        value: { bill: { status: string } };
      }
    ).value.bill.status;

  it("update auto-matches a transaction that carries the bill's new reference", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const bill = seedBill(u.id);
    seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
      bookingDate: "2026-09-10",
      reference: EXAMPLE_QRR,
    });
    expect(
      await outcome(() =>
        actions.update!(
          createTestEvent({
            user: u,
            params: { id: bill.id },
            form: refForm(),
          }) as never,
        ),
      ),
    ).toMatchObject({ type: "return" });
    expect(listBillAllocations(u.id, bill.id)).toHaveLength(1);
    expect(await statusOf(u, bill.id)).toBe("paid");
  });

  it("a failing auto-match never fails update", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id);
    failMatching();
    expect(
      await outcome(() =>
        actions.update!(
          createTestEvent({
            user: u,
            params: { id: bill.id },
            form: billForm({ amount: "50.00" }),
          }) as never,
        ),
      ),
    ).toMatchObject({ type: "return" });
  });

  it("the detail load never writes: a payment that arrived after the bill was saved stays a suggestion", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const bill = seedBill(u.id, {
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
      bookingDate: "2026-09-10",
      reference: EXAMPLE_QRR,
    });
    expect(await statusOf(u, bill.id)).toBe("open");
    expect(listBillAllocations(u.id, bill.id)).toEqual([]);
    const v = (await loadAs(u, bill.id)) as unknown as {
      value: { suggestions: { auto: boolean }[] };
    };
    expect(v.value.suggestions).toMatchObject([{ auto: true }]);
  });

  it("does not match another user's transactions", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const account = seedAccount(other.id);
    seedImportedTransaction(other.id, account.id, {
      amount: minor(-10000),
      bookingDate: "2026-09-10",
      reference: EXAMPLE_QRR,
    });
    const bill = seedBill(u.id, {
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    expect(await statusOf(u, bill.id)).toBe("open");
  });

  it("load returns the bill, allocations, suggestions, candidates, accounts and document", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id, { name: "Checking" });
    const bill = seedBill(u.id, { dueDate: "2000-01-01" });
    const tx = seedImportedTransaction(u.id, account.id, {
      amount: minor(-4000),
      counterpartyName: "Sample Payee",
    });
    const other = seedImportedTransaction(u.id, account.id, {
      amount: minor(-3000),
      description: "other",
    });
    allocate(u.id, bill.id, tx.id, minor(4000), "user");

    const r = await loadAs(u, bill.id, "?q=other");
    expect(r.type).toBe("return");
    const v = (r as { value: Record<string, unknown> }).value as never as {
      bill: { status: string; remaining: number; overdue: boolean };
      allocations: { transaction: { accountName: string } }[];
      candidates: { items: { id: string }[]; total: number };
      candidateQuery: string;
      accounts: unknown[];
      document: null;
      suggestions: unknown[];
    };
    expect(Object.keys(v).sort()).toEqual([
      "accounts",
      "allocations",
      "bill",
      "candidateQuery",
      "candidates",
      "dismissed",
      "document",
      "suggestions",
    ]);
    expect(v.bill).toMatchObject({
      status: "partially_paid",
      remaining: 6000,
      overdue: true,
    });
    expect(v.allocations[0]!.transaction.accountName).toBe("Checking");
    expect(v.candidates.items.map((i) => i.id)).toEqual([other.id]);
    expect(v.candidateQuery).toBe("other");
    expect(v.accounts).toEqual([
      { id: account.id, name: "Checking", currency: "CHF" },
    ]);
    expect(v.document).toBeNull();
  });

  it("updates, cancels, uncancels and deletes", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id);
    const bad = await run("update", u, bill.id, billForm({ amount: "-1" }));
    expect(bad).toMatchObject({
      type: "fail",
      status: 400,
      data: { action: "update", errors: { amount: [expect.any(String)] } },
    });
    expect(
      await run("update", u, bill.id, billForm({ notes: "hello" })),
    ).toEqual({ type: "return", value: { success: true, action: "update" } });
    expect(getBill(u.id, bill.id)).toMatchObject({
      notes: "hello",
      creditorIban: EXAMPLE_IBAN,
    });
    await run("cancel", u, bill.id);
    expect(getBill(u.id, bill.id).cancelled).toBe(true);
    await run("uncancel", u, bill.id);
    expect(getBill(u.id, bill.id).cancelled).toBe(false);
    expect(await run("delete", u, bill.id)).toEqual({
      type: "redirect",
      status: 303,
      location: "/bills",
    });
    expect(listBills(u.id)).toEqual([]);
  });

  it("allocates, rejects bad amounts and removes allocations", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const bill = seedBill(u.id);
    const tx = seedImportedTransaction(u.id, account.id, {
      amount: minor(-4000),
    });
    const tooMuch = await run("allocate", u, bill.id, {
      transactionId: tx.id,
      amount: "50.00",
    });
    expect(tooMuch).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "allocate",
        errors: { amount: [expect.any(String)] },
        values: { amount: "50.00" },
      },
    });
    expect(
      await run("allocate", u, bill.id, {
        transactionId: tx.id,
        amount: "40.00",
      }),
    ).toEqual({ type: "return", value: { success: true, action: "allocate" } });
    const [alloc] = listBillAllocations(u.id, bill.id);
    expect(
      await run("removeAllocation", u, bill.id, { allocationId: alloc!.id }),
    ).toEqual({
      type: "return",
      value: { success: true, action: "removeAllocation" },
    });
    expect(listBillAllocations(u.id, bill.id)).toEqual([]);
    expect(await run("removeAllocation", u, bill.id, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
  });

  it("dismisses a suggestion and brings it back with undismiss", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const bill = seedBill(u.id);
    const tx = seedImportedTransaction(u.id, account.id, {
      amount: minor(-4000),
    });
    await run("dismissSuggestion", u, bill.id, { transactionId: tx.id });
    const dismissed = async () =>
      (
        (await loadAs(u, bill.id)) as { value: { dismissed: { id: string }[] } }
      ).value.dismissed.map((t) => t.id);
    expect(await dismissed()).toEqual([tx.id]);
    expect(
      await run("undismiss", u, bill.id, { transactionId: tx.id }),
    ).toEqual({
      type: "return",
      value: { success: true, action: "undismiss" },
    });
    expect(await dismissed()).toEqual([]);
    expect(await run("undismiss", u, bill.id, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
    const other = await createTestUser();
    expect(
      await run("undismiss", other, bill.id, { transactionId: tx.id }),
    ).toEqual({ type: "error", status: 404 });
  });

  it("dismisses a suggestion for this bill", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const bill = seedBill(u.id);
    const tx = seedImportedTransaction(u.id, account.id, {
      amount: minor(-4000),
    });
    expect(
      await run("dismissSuggestion", u, bill.id, { transactionId: tx.id }),
    ).toEqual({
      type: "return",
      value: { success: true, action: "dismissSuggestion" },
    });
  });

  it("attaches a document, serves it and re-extracts without saving", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id, { creditorName: "Keep Me" });
    const attach = async (file: File) => {
      const event = createTestEvent({ user: u, params: { id: bill.id } });
      const body = new FormData();
      body.append("file", file);
      event.request = new Request("http://localhost/x", {
        method: "POST",
        body,
      });
      return outcome(() => actions.attachDocument(event as never));
    };
    expect(await attach(new File(["nope"], "a.pdf"))).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { file: [expect.any(String)] } },
    });
    const pdf = await qrPdf();
    expect(
      await attach(
        new File([pdf as BlobPart], "Bill (1).pdf", {
          type: "application/pdf",
        }),
      ),
    ).toEqual({
      type: "return",
      value: { success: true, action: "attachDocument" },
    });
    const docId = getBill(u.id, bill.id).documentId!;
    expect(getDocumentMeta(u.id, docId).fileName).toBe("Bill (1).pdf");

    const res = (await GET(
      createTestEvent({ user: u, params: { id: bill.id } }) as never,
    )) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      "inline; filename*=UTF-8''Bill%20%281%29.pdf",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; object-src 'none'; frame-ancestors 'self'",
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await res.arrayBuffer()).byteLength).toBe(pdf.byteLength);

    const re = await run("reextract", u, bill.id);
    expect(re).toMatchObject({
      type: "return",
      value: {
        success: true,
        action: "reextract",
        draft: { creditorName: "Example Energy Ltd" },
        extraction: { source: "qr" },
      },
    });
    expect(getBill(u.id, bill.id).creditorName).toBe("Keep Me");

    const none = seedBill(u.id);
    expect(await run("reextract", u, none.id)).toMatchObject({
      type: "fail",
      status: 400,
    });
  });

  it("the document endpoint 404s for a bill without one", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id);
    expect(
      await outcome(() =>
        GET(createTestEvent({ user: u, params: { id: bill.id } }) as never),
      ),
    ).toEqual({ type: "error", status: 404 });
  });

  it("another user cannot see or change the bill, its allocations or its document", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accountA = seedAccount(a.id);
    const accountB = seedAccount(b.id);
    const billA = seedBill(a.id);
    const billB = seedBill(b.id);
    const txA = seedImportedTransaction(a.id, accountA.id, {
      amount: minor(-1000),
    });
    const txB = seedImportedTransaction(b.id, accountB.id, {
      amount: minor(-1000),
    });
    const alloc = allocate(a.id, billA.id, txA.id, minor(1000), "user");
    const doc = storeDocument(a.id, await qrPdf(), "a.pdf", "application/pdf");
    attachDocument(a.id, billA.id, doc.id);

    const notFound = { type: "error", status: 404 };
    expect(await loadAs(b, billA.id)).toEqual(notFound);
    for (const name of [
      "update",
      "cancel",
      "uncancel",
      "delete",
      "reextract",
    ] as const) {
      expect(await run(name, b, billA.id, billForm()), name).toEqual(notFound);
    }
    expect(
      await run("allocate", b, billA.id, {
        transactionId: txB.id,
        amount: "10.00",
      }),
    ).toEqual(notFound);
    expect(
      await run("allocate", b, billB.id, {
        transactionId: txA.id,
        amount: "10.00",
      }),
    ).toEqual(notFound);
    expect(
      await run("removeAllocation", b, billA.id, { allocationId: alloc.id }),
    ).toEqual(notFound);
    expect(
      await run("removeAllocation", b, billB.id, { allocationId: alloc.id }),
    ).toMatchObject({ type: "fail", status: 404 });
    expect(
      await run("dismissSuggestion", b, billA.id, { transactionId: txB.id }),
    ).toEqual(notFound);
    expect(
      await run("dismissSuggestion", b, billB.id, { transactionId: txA.id }),
    ).toEqual(notFound);
    expect(
      await outcome(() =>
        GET(createTestEvent({ user: b, params: { id: billA.id } }) as never),
      ),
    ).toEqual(notFound);

    expect(getBill(a.id, billA.id)).toMatchObject({
      cancelled: false,
      documentId: doc.id,
    });
    expect(listBillAllocations(a.id, billA.id)).toHaveLength(1);
    expect(getDocumentMeta(a.id, doc.id).id).toBe(doc.id);
  });
});
