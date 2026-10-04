import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { minor } from "$lib/money";
import { listBillAllocations } from "$lib/server/bills/allocations";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { QRR } from "$lib/testing/fixtures/bills/payloads";
import { deleteBill, getBill, listBills } from "$lib/server/bills/bills";
import {
  bills,
  documents,
  getDB,
  paperlessConnections,
  paperlessDocuments,
  paperlessPending,
  users,
} from "$lib/server/db";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { clearEventListeners } from "$lib/server/events";
import {
  deleteConnection,
  getConnectionRow,
  saveConnection,
  setBillSourceRow,
} from "./connection";
import { PaperlessClient, classifyFetchError } from "./client";
import { startFakePaperless } from "./fake-server";
import {
  EXTERNAL_SOURCE,
  MAX_DOCUMENT_ATTEMPTS,
  REVIEW_NOTE,
  externalRef,
  instanceKey,
  syncConnection,
} from "./sync";
import { billPdf, plainPdf, seedConnection } from "./testing";

const fake = startFakePaperless();
afterAll(() => fake.stop());

let pdfEnergy: Uint8Array;
let pdfWater: Uint8Array;
let pdfOpen: Uint8Array;
let pdfNothing: Uint8Array;
beforeAll(async () => {
  pdfEnergy = await billPdf({ name: "Example Energy Ltd" });
  pdfWater = await billPdf({ name: "Sample Water AG", message: "Water 2026" });
  pdfOpen = await billPdf({
    name: "Open Amount Co",
    iban: EXAMPLE_IBAN,
    amount: "",
    referenceType: "NON",
    reference: "",
  });
  pdfNothing = await plainPdf();
}, 60_000);

describe("syncConnection", () => {
  useTestDB();
  useTestStore();
  let user: TestUser;

  beforeEach(async () => {
    fake.requests = [];
    fake.docs.clear();
    fake.savedViews = [];
    fake.pageSize = null;
    fake.wrongHostNext = false;
    fake.downloadStatus = 200;
    fake.token = "test-token";
    fake.prefix = "";
    user = await createTestUser();
    seedConnection(user.id, fake);
  });
  afterEach(() => {
    clearEventListeners();
    vi.restoreAllMocks();
  });

  const linkOf = (paperlessId: number, userId = user.id) =>
    getDB()
      .select()
      .from(paperlessDocuments)
      .where(
        and(
          eq(paperlessDocuments.userId, userId),
          eq(paperlessDocuments.paperlessId, paperlessId),
        ),
      )
      .get();

  describe("with KEPT_ALLOW_PRIVATE_NETWORK cleared", () => {
    beforeEach(() => vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", ""));
    afterEach(() => vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "true"));

    it("a member's stored private connection is never contacted", async () => {
      fake.addDoc({ id: 11, original: pdfEnergy, tags: [1] });
      fake.requests = [];
      const r = await syncConnection(user.id);
      expect(r.error).toBe("blocked_address");
      expect(fake.requests).toHaveLength(0);
      expect(listBills(user.id)).toHaveLength(0);
    });

    it("an administrator is allowed, and blocked from the next sync after losing the role", async () => {
      const admin = await createTestUser({ role: "admin" });
      seedConnection(admin.id, fake);
      fake.addDoc({ id: 11, original: pdfEnergy, tags: [1] });
      expect((await syncConnection(admin.id)).imported).toBe(1);

      getDB()
        .update(users)
        .set({ role: "member" })
        .where(eq(users.id, admin.id))
        .run();
      fake.requests = [];
      fake.addDoc({ id: 12, original: pdfWater, tags: [1] });
      const r = await syncConnection(admin.id);
      expect(r.error).toBe("blocked_address");
      expect(fake.requests).toHaveLength(0);
    });
  });

  it("imports tagged PDFs as bills with an external reference and a stored document", async () => {
    fake.addDoc({ id: 11, original: pdfEnergy, tags: [1] });
    fake.addDoc({ id: 12, original: pdfWater, tags: [2] });

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({
      listed: 1,
      imported: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      error: null,
    });
    const all = listBills(user.id);
    expect(all).toHaveLength(1);
    const bill = all[0]!;
    const base = getConnectionRow(user.id)!.baseUrl;
    expect(bill).toMatchObject({
      creditorName: "Example Energy Ltd",
      amount: 194975,
      currency: "CHF",
      externalSource: EXTERNAL_SOURCE,
      externalRef: externalRef(base, 11),
      externalUrl: `${base}/documents/11/details`,
      notes: null,
    });
    const doc = getDB().select().from(documents).get()!;
    expect(doc).toMatchObject({
      userId: user.id,
      source: "integration",
      id: bill.documentId,
    });
    expect(linkOf(11)).toMatchObject({
      status: "imported",
      billId: bill.id,
      documentId: doc.id,
    });
    expect(linkOf(12)).toBeUndefined();

    const list = fake
      .requestsTo("/api/documents/", "GET")
      .find((q) => q.query.has("ordering"))!;
    expect(list.query.get("tags__id__all")).toBe("1");
    expect(list.query.get("fields")).not.toContain("content");
    const download = fake.requestsTo("/download/")[0]!;
    expect(download.query.get("original")).toBe("true");
    expect(getConnectionRow(user.id)).toMatchObject({ lastError: null });
    expect(getConnectionRow(user.id)!.lastSyncAt).toBeInstanceOf(Date);
  });

  it("auto-matches an imported bill against a payment that is already booked", async () => {
    const account = await seedAccount(user.id);
    await seedImportedTransaction(user.id, account.id, {
      amount: minor(-194975),
      bookingDate: "2026-09-10",
      reference: QRR,
    });
    fake.addDoc({ id: 11, original: pdfEnergy, tags: [1] });

    await syncConnection(user.id);

    const [bill] = listBills(user.id);
    expect(listBillAllocations(user.id, bill!.id)).toHaveLength(1);
  });

  it("does not duplicate on re-sync and does not download unchanged documents again", async () => {
    fake.addDoc({ id: 11, original: pdfEnergy });
    await syncConnection(user.id);
    fake.requests = [];

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ imported: 0, unchanged: 1 });
    expect(listBills(user.id)).toHaveLength(1);
    expect(fake.requestsTo("/download/")).toHaveLength(0);
  });

  it("uses a saved view's rules as the source and re-reads them each time", async () => {
    setBillSourceRow(user.id, {
      kind: "saved_view",
      id: 5,
      label: "Bills view",
    });
    fake.savedViews = [
      {
        id: 5,
        name: "Bills view",
        filter_rules: [{ rule_type: 6, value: "2" }],
      },
    ];
    fake.addDoc({ id: 21, original: pdfWater, tags: [2] });
    fake.addDoc({ id: 22, original: pdfEnergy, tags: [1] });

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ imported: 1, error: null });
    expect(listBills(user.id)[0]!.creditorName).toBe("Sample Water AG");
    const list = fake
      .requestsTo("/api/documents/", "GET")
      .find((q) => q.query.has("ordering"))!;
    expect(list.query.get("tags__id__all")).toBe("2");
  });

  it("stops with a clear code for a saved view it cannot apply", async () => {
    setBillSourceRow(user.id, { kind: "saved_view", id: 5, label: "Fulltext" });
    fake.savedViews = [
      {
        id: 5,
        name: "Fulltext",
        filter_rules: [{ rule_type: 20, value: "rent" }],
      },
    ];
    fake.addDoc({ id: 21, original: pdfWater });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await syncConnection(user.id);

    expect(r.error).toBe("source_unsupported");
    expect(listBills(user.id)).toHaveLength(0);
    expect(getConnectionRow(user.id)!.lastError).toBe("source_unsupported");
  });

  it("reports a missing source and a rejected token without throwing", async () => {
    const other = await createTestUser();
    seedConnection(other.id, fake, { source: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await syncConnection(other.id)).error).toBe("no_source");

    fake.token = "rotated";
    const r = await syncConnection(user.id);
    expect(r.error).toBe("unauthorized");
    expect(getConnectionRow(user.id)!.lastError).toBe("unauthorized");
  });

  it("follows pagination, ignoring hosts named in next links", async () => {
    fake.addDoc({
      id: 31,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    fake.addDoc({
      id: 32,
      original: pdfEnergy,
      modified: "2026-09-01T11:00:00+00:00",
    });
    fake.addDoc({
      id: 33,
      original: pdfEnergy,
      modified: "2026-09-01T12:00:00+00:00",
    });
    fake.pageSize = 1;
    fake.wrongHostNext = true;

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ listed: 3, imported: 3 });
    expect(listBills(user.id)).toHaveLength(3);
    // The same bytes are stored once.
    expect(getDB().select().from(documents).all()).toHaveLength(1);
  });

  it("moves the watermark and asks only for newer documents with a five minute overlap", async () => {
    fake.addDoc({
      id: 41,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    await syncConnection(user.id);
    expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
      Date.parse("2026-09-01T10:00:00+00:00"),
    );

    fake.requests = [];
    fake.addDoc({
      id: 42,
      original: pdfWater,
      modified: "2026-09-01T10:02:00+00:00",
    });
    fake.addDoc({
      id: 40,
      original: pdfEnergy,
      modified: "2026-08-01T10:00:00+00:00",
    });
    const r = await syncConnection(user.id);

    const list = fake
      .requestsTo("/api/documents/", "GET")
      .find((q) => q.query.has("ordering"))!;
    expect(list.query.get("modified__gt")).toBe("2026-09-01T09:55:00.000Z");
    expect(r).toMatchObject({ listed: 2, imported: 1, unchanged: 1 });
    expect(linkOf(40)).toBeUndefined();
    expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
      Date.parse("2026-09-01T10:02:00+00:00"),
    );
  });

  it("stops the run on connection-level problems without moving the watermark, and retries later", async () => {
    fake.addDoc({
      id: 51,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    fake.addDoc({
      id: 52,
      original: pdfWater,
      modified: "2026-09-01T11:00:00+00:00",
    });
    fake.downloadStatus = 401;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await syncConnection(user.id);

    expect(first.error).toBe("unauthorized");
    expect(listBills(user.id)).toHaveLength(0);
    expect(getConnectionRow(user.id)!.lastSyncModified).toBeNull();

    fake.downloadStatus = 200;
    const second = await syncConnection(user.id);
    expect(second).toMatchObject({ imported: 2, error: null });
  });

  it("a document Paperless cannot serve is recorded and does not block later ones", async () => {
    for (const [id, hour] of [
      [51, "10"],
      [52, "11"],
      [53, "12"],
      [54, "13"],
    ] as const) {
      fake.addDoc({
        id,
        original: pdfEnergy,
        modified: `2026-09-01T${hour}:00:00+00:00`,
      });
    }
    fake.downloadStatuses.set(51, 422);
    fake.downloadStatuses.set(52, 403);
    fake.downloadStatuses.set(53, 400);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ failed: 3, imported: 1, error: null });
    expect(linkOf(51)).toMatchObject({
      status: "failed",
      error: "Paperless sent an unreadable response for this document.",
    });
    expect(linkOf(52)!.error).toBe(
      "Paperless did not allow reading this document.",
    );
    expect(linkOf(54)).toMatchObject({ status: "imported" });
    expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
      Date.parse("2026-09-01T13:00:00+00:00"),
    );
    expect(getConnectionRow(user.id)!.lastError).toBeNull();
  });

  it.each([502, 503, 429, 408])(
    "a transient %i leaves the document pending and retries it on the next run",
    async (status) => {
      fake.addDoc({
        id: 41,
        original: pdfEnergy,
        modified: "2026-09-01T10:00:00+00:00",
      });
      fake.addDoc({
        id: 42,
        original: pdfWater,
        modified: "2026-09-01T11:00:00+00:00",
      });
      fake.downloadStatuses.set(41, status);

      const first = await syncConnection(user.id);

      expect(first).toMatchObject({
        imported: 1,
        failed: 0,
        pending: 1,
        error: null,
      });
      expect(linkOf(41)).toBeUndefined();
      expect(linkOf(42)).toMatchObject({ status: "imported" });
      // The watermark must not move past the document that still needs a retry.
      expect(getConnectionRow(user.id)!.lastSyncModified).toBeNull();

      fake.downloadStatuses.delete(41);
      const second = await syncConnection(user.id);

      expect(second).toMatchObject({ imported: 1, failed: 0, pending: 0 });
      expect(linkOf(41)).toMatchObject({ status: "imported" });
      expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
        Date.parse("2026-09-01T11:00:00+00:00"),
      );
    },
  );

  const timeoutOn = (...ids: number[]) => {
    const original = PaperlessClient.prototype.download;
    return vi
      .spyOn(PaperlessClient.prototype, "download")
      .mockImplementation(function (this: PaperlessClient, path, ...rest) {
        if (ids.some((id) => path.startsWith(`documents/${id}/`))) {
          return Promise.reject(
            classifyFetchError(new DOMException("timed out", "TimeoutError")),
          );
        }
        return original.call(this, path, ...rest);
      });
  };

  it("a download that times out leaves that document pending while later ones still sync", async () => {
    fake.addDoc({
      id: 141,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    fake.addDoc({
      id: 142,
      original: pdfWater,
      modified: "2026-09-01T11:00:00+00:00",
    });
    fake.addDoc({
      id: 143,
      original: pdfOpen,
      modified: "2026-09-01T12:00:00+00:00",
    });
    const spy = timeoutOn(141);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await syncConnection(user.id);

    expect(first).toMatchObject({
      imported: 2,
      pending: 1,
      failed: 0,
      error: null,
    });
    expect(linkOf(141)).toBeUndefined();
    expect(linkOf(142)).toMatchObject({ status: "imported" });
    expect(linkOf(143)).toMatchObject({ status: "imported" });
    expect(getConnectionRow(user.id)!.lastSyncModified).toBeNull();
    expect(getConnectionRow(user.id)!.lastError).toBeNull();

    spy.mockRestore();
    const second = await syncConnection(user.id);
    expect(second).toMatchObject({ imported: 1, pending: 0, error: null });
    expect(getDB().select().from(paperlessPending).all()).toHaveLength(0);
    expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
      Date.parse("2026-09-01T12:00:00+00:00"),
    );
  });

  it("still stops the run when every download fails to connect", async () => {
    for (const [id, hour] of [
      [151, "10"],
      [152, "11"],
      [153, "12"],
      [154, "13"],
    ] as const) {
      fake.addDoc({
        id,
        original: pdfEnergy,
        modified: `2026-09-01T${hour}:00:00+00:00`,
      });
    }
    timeoutOn(151, 152, 153, 154);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await syncConnection(user.id);

    expect(r.error).toBe("network");
    expect(r.pending).toBeLessThan(4);
    expect(getConnectionRow(user.id)!.lastSyncModified).toBeNull();
    expect(getDB().select().from(paperlessPending).all()).toHaveLength(0);
  });

  it("gives up on a document that keeps failing after the attempt cap and releases the watermark", async () => {
    fake.addDoc({
      id: 161,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    fake.addDoc({
      id: 162,
      original: pdfWater,
      modified: "2026-09-01T11:00:00+00:00",
    });
    fake.downloadStatuses.set(161, 500);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let run = 1; run < MAX_DOCUMENT_ATTEMPTS; run++) {
      const r = await syncConnection(user.id);
      expect(r).toMatchObject({ pending: 1, failed: 0 });
      expect(getConnectionRow(user.id)!.lastSyncModified).toBeNull();
      expect(getDB().select().from(paperlessPending).get()!.attempts).toBe(run);
    }

    const last = await syncConnection(user.id);

    expect(last).toMatchObject({ pending: 0, failed: 1 });
    expect(linkOf(161)).toMatchObject({ status: "failed" });
    expect(linkOf(161)!.error).toMatch(/repeatedly|several/i);
    expect(getDB().select().from(paperlessPending).all()).toHaveLength(0);
    expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
      Date.parse("2026-09-01T11:00:00+00:00"),
    );
    // Failed documents are left alone until they change.
    fake.downloadStatuses.delete(161);
    expect(await syncConnection(user.id)).toMatchObject({
      imported: 0,
      failed: 0,
      pending: 0,
    });
  });

  it("gives up on a document that has been failing for a day", async () => {
    fake.addDoc({
      id: 171,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    fake.downloadStatuses.set(171, 503);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await syncConnection(user.id)).toMatchObject({ pending: 1 });
    getDB()
      .update(paperlessPending)
      .set({ firstFailedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .run();

    expect(await syncConnection(user.id)).toMatchObject({
      pending: 0,
      failed: 1,
    });
    expect(linkOf(171)).toMatchObject({ status: "failed" });
    expect(getConnectionRow(user.id)!.lastSyncModified).toBe(
      Date.parse("2026-09-01T10:00:00+00:00"),
    );
  });

  it("keeps permanent client errors failed until the document changes", async () => {
    fake.addDoc({ id: 43, original: pdfEnergy });
    fake.downloadStatuses.set(43, 422);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await syncConnection(user.id)).toMatchObject({
      failed: 1,
      pending: 0,
    });
    expect(linkOf(43)).toMatchObject({ status: "failed" });
    fake.downloadStatuses.delete(43);
    expect(await syncConnection(user.id)).toMatchObject({
      failed: 0,
      imported: 0,
    });
  });

  it("skips documents that are not PDFs, using the archive version of images", async () => {
    fake.addDoc({
      id: 61,
      mime_type: "application/vnd.oasis.opendocument.text",
      archived_file_name: null,
    });
    fake.addDoc({ id: 62, mime_type: "image/png", archived_file_name: null });
    fake.addDoc({
      id: 63,
      mime_type: "image/png",
      archive: pdfEnergy,
      original: new Uint8Array([137, 80, 78, 71]),
    });
    fake.addDoc({ id: 64, original: pdfEnergy, contentType: "text/html" });
    fake.addDoc({
      id: 65,
      original: new TextEncoder().encode("not a pdf at all"),
      contentType: "application/pdf",
    });

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ listed: 5, imported: 1, skipped: 4, failed: 0 });
    expect(linkOf(61)).toMatchObject({ status: "skipped" });
    expect(linkOf(64)).toMatchObject({
      status: "skipped",
      error: "The file is not a PDF.",
    });
    expect(linkOf(63)).toMatchObject({ status: "imported" });
    const archiveDownload = fake.requestsTo("/63/download/")[0]!;
    expect(archiveDownload.query.has("original")).toBe(false);
    expect(listBills(user.id)).toHaveLength(1);
  });

  it("records a failure with a reason for documents without bill data and keeps no file", async () => {
    fake.addDoc({ id: 71, original: pdfNothing });

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ failed: 1, imported: 0 });
    expect(listBills(user.id)).toHaveLength(0);
    expect(linkOf(71)).toMatchObject({
      status: "failed",
      billId: null,
      error: "No creditor name or IBAN was found in the document.",
    });
    expect(getDB().select().from(documents).all()).toHaveLength(0);
    // A failed document is not retried until it changes.
    fake.requests = [];
    expect((await syncConnection(user.id)).failed).toBe(0);
    expect(fake.requestsTo("/download/")).toHaveLength(0);
  });

  it("imports a bill with only a creditor and marks it for review", async () => {
    fake.addDoc({ id: 81, original: pdfOpen });

    const r = await syncConnection(user.id);

    expect(r.imported).toBe(1);
    const bill = listBills(user.id)[0]!;
    expect(bill).toMatchObject({
      creditorName: "Open Amount Co",
      amount: null,
      reference: null,
      notes: REVIEW_NOTE,
    });
  });

  it("swaps the stored file when the document changed, keeping the bill", async () => {
    fake.addDoc({
      id: 91,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    await syncConnection(user.id);
    const before = listBills(user.id)[0]!;

    fake.docs.get(91)!.original = pdfWater;
    fake.docs.get(91)!.modified = "2026-09-02T10:00:00+00:00";
    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ updated: 1, imported: 0 });
    const after = getBill(user.id, before.id);
    expect(after.documentId).not.toBe(before.documentId);
    expect(listBills(user.id)).toHaveLength(1);
    // The replaced integration file is gone.
    expect(
      getDB()
        .select()
        .from(documents)
        .all()
        .map((d) => d.id),
    ).toEqual([after.documentId]);
  });

  it("only touches modified when the metadata changed but the file did not", async () => {
    fake.addDoc({
      id: 92,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    await syncConnection(user.id);
    fake.docs.get(92)!.modified = "2026-09-03T10:00:00+00:00";

    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ unchanged: 1, updated: 0 });
    expect(linkOf(92)!.modified).toBe(Date.parse("2026-09-03T10:00:00+00:00"));
  });

  it("does not bring back a bill the user deleted", async () => {
    fake.addDoc({
      id: 93,
      original: pdfEnergy,
      modified: "2026-09-01T10:00:00+00:00",
    });
    await syncConnection(user.id);
    await deleteBill(user.id, listBills(user.id)[0]!.id);
    expect(linkOf(93)).toMatchObject({ billId: null, status: "imported" });

    fake.docs.get(93)!.modified = "2026-09-04T10:00:00+00:00";
    await syncConnection(user.id);

    expect(listBills(user.id)).toHaveLength(0);
  });

  it("links the existing bill instead of importing a duplicate after reconnecting", async () => {
    fake.addDoc({ id: 94, original: pdfEnergy });
    await syncConnection(user.id);
    const original = listBills(user.id)[0]!;

    deleteConnection(user.id);
    expect(getDB().select().from(paperlessDocuments).all()).toHaveLength(0);
    expect(getBill(user.id, original.id).externalUrl).toBe(
      original.externalUrl,
    );
    seedConnection(user.id, fake);
    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ imported: 0, unchanged: 1 });
    expect(listBills(user.id)).toHaveLength(1);
    expect(linkOf(94)).toMatchObject({ billId: original.id });
  });

  it("does not bring back a deleted bill after reconnecting", async () => {
    fake.addDoc({ id: 96, original: pdfEnergy });
    await syncConnection(user.id);
    await deleteBill(user.id, listBills(user.id)[0]!.id);

    deleteConnection(user.id);
    seedConnection(user.id, fake);
    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ imported: 0, unchanged: 1 });
    expect(listBills(user.id)).toHaveLength(0);
    expect(linkOf(96)).toMatchObject({ billId: null, status: "imported" });
  });

  it("does not bring back a deleted bill after moving to another address and back", async () => {
    fake.addDoc({ id: 97, original: pdfEnergy });
    await syncConnection(user.id);
    await deleteBill(user.id, listBills(user.id)[0]!.id);

    const input = { token: null, allowInsecureTls: false };
    saveConnection(user.id, { ...input, baseUrl: `${fake.origin}/other` });
    saveConnection(user.id, { ...input, baseUrl: fake.baseUrl });
    await syncConnection(user.id);

    expect(listBills(user.id)).toHaveLength(0);
  });

  it("changing the address keeps the links, the watermark and the bill urls", async () => {
    fake.addDoc({ id: 95, original: pdfEnergy });
    await syncConnection(user.id);
    const [bill] = listBills(user.id);
    const watermark = getConnectionRow(user.id)!.lastSyncModified;
    expect(watermark).not.toBeNull();
    const oldBase = fake.baseUrl;

    saveConnection(user.id, {
      baseUrl: `${fake.origin}/other`,
      token: null,
      allowInsecureTls: false,
    });

    expect(getDB().select().from(paperlessDocuments).all()).toHaveLength(1);
    expect(getConnectionRow(user.id)).toMatchObject({
      lastSyncModified: watermark,
    });
    expect(getBill(user.id, bill!.id).externalUrl).toBe(
      `${fake.origin}/other/documents/95/details`,
    );
    expect(getBill(user.id, bill!.id).externalRef).toBe(
      externalRef(oldBase, 95),
    );
  });

  it("does not duplicate any bill after the address changed", async () => {
    fake.addDoc({ id: 95, original: pdfEnergy });
    await syncConnection(user.id);
    // Same server, new address: here the fake keeps answering on the old one too.
    fake.prefix = "/other";
    saveConnection(user.id, {
      baseUrl: `${fake.origin}/other`,
      token: null,
      allowInsecureTls: false,
    });
    getDB().update(paperlessConnections).set({ lastSyncModified: null }).run();
    const r = await syncConnection(user.id);
    expect(r).toMatchObject({ imported: 0, unchanged: 1, failed: 0 });
    expect(listBills(user.id)).toHaveLength(1);
  });

  it("keeps a legacy connection (no stored key) on the key its bills already have", async () => {
    fake.addDoc({ id: 95, original: pdfEnergy });
    await syncConnection(user.id);
    getDB().update(paperlessConnections).set({ instanceKey: null }).run();
    const legacyKey = instanceKey(fake.baseUrl);
    fake.prefix = "/other";
    saveConnection(user.id, {
      baseUrl: `${fake.origin}/other`,
      token: null,
      allowInsecureTls: false,
    });
    expect(getConnectionRow(user.id)!.instanceKey).toBe(legacyKey);
  });

  it("a different instance resets links and watermark and gets a fresh key", async () => {
    fake.addDoc({ id: 95, original: pdfEnergy });
    await syncConnection(user.id);
    const before = getConnectionRow(user.id)!;

    saveConnection(user.id, {
      baseUrl: `${fake.origin}/other`,
      token: null,
      allowInsecureTls: false,
      differentInstance: true,
    });

    expect(getDB().select().from(paperlessDocuments).all()).toHaveLength(0);
    const after = getConnectionRow(user.id)!;
    expect(after.lastSyncModified).toBeNull();
    expect(after.instanceKey).not.toBe(before.instanceKey);
    expect(listBills(user.id)).toHaveLength(1);

    fake.prefix = "/other";
    await syncConnection(user.id);
    expect(listBills(user.id)).toHaveLength(2);
  });

  it("reconnecting after a different-server reset reuses the key and creates no duplicates", async () => {
    fake.addDoc({ id: 95, original: pdfEnergy });
    fake.prefix = "/other";
    saveConnection(user.id, {
      baseUrl: fake.baseUrl,
      token: null,
      allowInsecureTls: false,
      differentInstance: true,
    });
    await syncConnection(user.id);
    const [bill] = listBills(user.id);
    const key = getConnectionRow(user.id)!.instanceKey;

    deleteConnection(user.id);
    seedConnection(user.id, fake);
    expect(getConnectionRow(user.id)!.instanceKey).toBe(key);
    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ imported: 0, unchanged: 1, failed: 0 });
    expect(listBills(user.id)).toHaveLength(1);
    expect(linkOf(95)).toMatchObject({ billId: bill!.id });
  });

  it("reconnecting at the new address after a move reuses the key and creates no duplicates", async () => {
    fake.addDoc({ id: 95, original: pdfEnergy });
    await syncConnection(user.id);
    const [bill] = listBills(user.id);
    const key = getConnectionRow(user.id)!.instanceKey;
    fake.prefix = "/other";
    saveConnection(user.id, {
      baseUrl: fake.baseUrl,
      token: null,
      allowInsecureTls: false,
    });

    deleteConnection(user.id);
    seedConnection(user.id, fake);
    expect(getConnectionRow(user.id)!.instanceKey).toBe(key);
    expect(key).not.toBe(instanceKey(fake.baseUrl));
    const r = await syncConnection(user.id);

    expect(r).toMatchObject({ imported: 0, unchanged: 1, failed: 0 });
    expect(listBills(user.id)).toHaveLength(1);
    expect(linkOf(95)).toMatchObject({ billId: bill!.id });
  });

  it("does not reuse another user's remembered key", async () => {
    const other = await createTestUser();
    fake.prefix = "/other";
    saveConnection(user.id, {
      baseUrl: fake.baseUrl,
      token: null,
      allowInsecureTls: false,
      differentInstance: true,
    });
    const key = getConnectionRow(user.id)!.instanceKey;
    deleteConnection(user.id);

    seedConnection(other.id, fake);
    expect(getConnectionRow(other.id)!.instanceKey).toBe(
      instanceKey(fake.baseUrl),
    );
    expect(key).not.toBe(instanceKey(fake.baseUrl));
  });

  describe("for specific documents (webhook)", () => {
    it("reports documents that are not visible yet and imports them once they are", async () => {
      fake.addDoc({ id: 101, original: pdfEnergy, hiddenRequests: 1 });

      const first = await syncConnection(user.id, { documentIds: [101] });
      expect(first.missing).toEqual([101]);
      expect(listBills(user.id)).toHaveLength(0);

      const second = await syncConnection(user.id, { documentIds: [101] });
      expect(second).toMatchObject({ imported: 1, missing: [] });
      expect(getConnectionRow(user.id)!.lastSyncModified).toBeNull();
    });

    it("ignores documents outside the bill source", async () => {
      fake.addDoc({ id: 102, original: pdfEnergy, tags: [9] });

      const r = await syncConnection(user.id, { documentIds: [102] });

      expect(r).toMatchObject({ listed: 0, imported: 0, missing: [] });
      expect(listBills(user.id)).toHaveLength(0);
    });

    it("is idempotent for repeated deliveries", async () => {
      fake.addDoc({ id: 103, original: pdfEnergy });
      await syncConnection(user.id, { documentIds: [103] });
      const again = await syncConnection(user.id, { documentIds: [103] });
      expect(again).toMatchObject({ imported: 0, unchanged: 1 });
      expect(listBills(user.id)).toHaveLength(1);
    });
  });

  it("serialises overlapping syncs of one connection", async () => {
    fake.addDoc({ id: 111, original: pdfEnergy });
    const [a, b] = await Promise.all([
      syncConnection(user.id),
      syncConnection(user.id),
    ]);
    expect(a.imported + b.imported).toBe(1);
    expect(listBills(user.id)).toHaveLength(1);
  });

  it("keeps users apart: one user's sync never creates or shows another user's bills", async () => {
    const other = await createTestUser();
    seedConnection(other.id, fake);
    fake.addDoc({ id: 121, original: pdfEnergy });

    await syncConnection(user.id);

    expect(listBills(user.id)).toHaveLength(1);
    expect(listBills(other.id)).toHaveLength(0);
    expect(linkOf(121, other.id)).toBeUndefined();
    expect(
      getDB().select().from(bills).where(eq(bills.userId, other.id)).all(),
    ).toHaveLength(0);
    // The other user can sync the same Paperless document into their own account.
    await syncConnection(other.id);
    expect(listBills(other.id)).toHaveLength(1);
    expect(listBills(user.id)).toHaveLength(1);
    expect(
      getDB()
        .select()
        .from(paperlessConnections)
        .all()
        .map((c) => c.userId)
        .sort(),
    ).toEqual([user.id, other.id].sort());
  });

  it("never logs creditor names, amounts or IBANs", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    fake.addDoc({ id: 131, original: pdfEnergy });
    fake.addDoc({ id: 132, original: pdfNothing });
    fake.downloadStatus = 200;
    await syncConnection(user.id);
    fake.token = "bad";
    await syncConnection(user.id);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of ["Example Energy", "1949", "CH44", "test-token"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
