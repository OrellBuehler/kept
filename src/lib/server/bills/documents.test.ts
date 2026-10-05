import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { LedgerError } from "$lib/server/ledger/errors";
import { bills, documents, getDB, first } from "$lib/server/db";
import { createStore, readStorageConfig, setStore } from "$lib/server/storage";
import { seedBill } from "$lib/testing/bills";
import {
  attachDocument,
  deleteBill,
  getBill,
  sweepUnreferencedDocuments,
} from "./bills";
import {
  MAX_DOCUMENT_BYTES,
  deleteDocument,
  deleteDocumentWhere,
  getDocumentMeta,
  hasPdfMagic,
  readDocument,
  sanitizeFileName,
  storeDocument,
} from "./documents";

const pdf = (extra = "") =>
  new TextEncoder().encode(`%PDF-1.4\n${extra}\n%%EOF`);

describe("documents", () => {
  useTestDB();
  const blobs = useTestStore();

  const keys = async () =>
    (await Array.fromAsync(blobs.store.list(""))).map((i) => i.key);

  it("stores a PDF under documents/<userId>/<id> and reads it back", async () => {
    const u = await createTestUser();
    const doc = await storeDocument(u.id, pdf("a"), "bill.pdf", "text/plain");
    expect(doc).toMatchObject({
      fileName: "bill.pdf",
      mimeType: "application/pdf",
      source: "upload",
    });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await keys()).toEqual([`documents/${u.id}/${doc.id}`]);
    const row = await first(
      getDB()
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .limit(1),
    );
    expect(row?.storageKey).toBe(`${u.id}/${doc.id}`);
    const read = await readDocument(u.id, doc.id);
    expect(new TextDecoder().decode(read.bytes)).toContain("%PDF-1.4");
    expect(read.meta.size).toBe(pdf("a").byteLength);
  });

  it("rejects files that are not PDFs by content, empty or too large", async () => {
    const u = await createTestUser();
    const code = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof LedgerError) return `${e.code}:${e.field}`;
        throw e;
      }
      return "none";
    };
    const text = new TextEncoder().encode("hello");
    expect(
      await code(() => storeDocument(u.id, text, "x.pdf", "application/pdf")),
    ).toBe("invalid:file");
    expect(
      await code(() =>
        storeDocument(u.id, new Uint8Array(), "x.pdf", "application/pdf"),
      ),
    ).toBe("invalid:file");
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(pdf());
    expect(
      await code(() => storeDocument(u.id, big, "x.pdf", "application/pdf")),
    ).toBe("invalid:file");
    expect(await keys()).toEqual([]);
    const exact = new Uint8Array(MAX_DOCUMENT_BYTES);
    exact.set(pdf());
    expect(
      await code(() => storeDocument(u.id, exact, "x.pdf", "application/pdf")),
    ).toBe("none");
    expect(await getDB().select().from(documents)).toHaveLength(1);
  });

  it("returns the existing document for identical content of the same user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const first = await storeDocument(
      a.id,
      pdf("same"),
      "one.pdf",
      "application/pdf",
    );
    const again = await storeDocument(
      a.id,
      pdf("same"),
      "two.pdf",
      "application/pdf",
    );
    expect(again.id).toBe(first.id);
    expect(again.fileName).toBe("one.pdf");
    const other = await storeDocument(
      b.id,
      pdf("same"),
      "one.pdf",
      "application/pdf",
    );
    expect(other.id).not.toBe(first.id);
    expect(await keys()).toHaveLength(2);
  });

  it("stores identical content uploaded concurrently once", async () => {
    const u = await createTestUser();
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        storeDocument(u.id, pdf("race"), `${n}.pdf`, "application/pdf"),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await getDB().select().from(documents)).toHaveLength(1);
    expect(await keys()).toEqual([`documents/${u.id}/${results[0]!.id}`]);
    expect((await readDocument(u.id, results[0]!.id)).bytes.byteLength).toBe(
      pdf("race").byteLength,
    );
  });

  it("restores a missing file when the same content is uploaded again", async () => {
    const u = await createTestUser();
    const doc = await storeDocument(u.id, pdf("x"), "a.pdf", "application/pdf");
    await blobs.store.delete(`documents/${u.id}/${doc.id}`);
    await expect(readDocument(u.id, doc.id)).rejects.toThrow(LedgerError);
    await storeDocument(u.id, pdf("x"), "a.pdf", "application/pdf");
    expect((await readDocument(u.id, doc.id)).bytes.byteLength).toBeGreaterThan(
      0,
    );
  });

  it("never lets the file name influence the storage key", async () => {
    const u = await createTestUser();
    const doc = await storeDocument(
      u.id,
      pdf("p"),
      "../../etc/passwd\u0000.pdf",
      "application/pdf",
    );
    expect(doc.fileName).toBe("passwd.pdf");
    expect(await keys()).toEqual([`documents/${u.id}/${doc.id}`]);
    expect(sanitizeFileName("..")).toBe("document.pdf");
    expect(sanitizeFileName("a\\b\\c.pdf")).toBe("c.pdf");
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(200);
  });

  it("checks the PDF signature at the start, allowing leading whitespace", async () => {
    const u = await createTestUser();
    const enc = (t: string) => new TextEncoder().encode(t);
    await expect(
      storeDocument(u.id, enc("\n \r%PDF-1.4"), "a.pdf", "x"),
    ).resolves.toBeDefined();
    await expect(
      storeDocument(u.id, enc("junk%PDF-1.4"), "b.pdf", "x"),
    ).rejects.toThrow(LedgerError);
    expect(hasPdfMagic(enc("<html>%PDF-"))).toBe(false);
  });

  it("sweeps old unreferenced uploads only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const bill = await seedBill(u.id);
    const old = await storeDocument(u.id, pdf("old"), "a.pdf", "x");
    const used = await storeDocument(u.id, pdf("used"), "b.pdf", "x");
    const fresh = await storeDocument(u.id, pdf("fresh"), "c.pdf", "x");
    const foreign = await storeDocument(other.id, pdf("old"), "d.pdf", "x");
    await attachDocument(u.id, bill.id, used.id);
    const dayAndAbit = Date.now() - 25 * 3600 * 1000;
    for (const id of [old.id, used.id, foreign.id]) {
      await getDB()
        .update(documents)
        .set({ createdAt: new Date(dayAndAbit) })
        .where(eq(documents.id, id));
    }
    expect(await sweepUnreferencedDocuments(u.id)).toBe(1);
    await expect(getDocumentMeta(u.id, old.id)).rejects.toThrow(LedgerError);
    expect(await blobs.store.has(`documents/${u.id}/${old.id}`)).toBe(false);
    expect((await getDocumentMeta(u.id, used.id)).id).toBe(used.id);
    expect((await getDocumentMeta(u.id, fresh.id)).id).toBe(fresh.id);
    expect((await getDocumentMeta(other.id, foreign.id)).id).toBe(foreign.id);
    expect(await blobs.store.has(`documents/${other.id}/${foreign.id}`)).toBe(
      true,
    );
  });

  it("a sweep does not delete a document attached after it selected the stale ones", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    const a = await storeDocument(u.id, pdf("a"), "a.pdf", "x");
    const b = await storeDocument(u.id, pdf("b"), "b.pdf", "x");
    const dayAndAbit = new Date(Date.now() - 25 * 3600 * 1000);
    await getDB().update(documents).set({ createdAt: dayAndAbit });
    const realDelete = blobs.store.delete.bind(blobs.store);
    let kept = "";
    vi.spyOn(blobs.store, "delete").mockImplementation(async (key) => {
      await realDelete(key);
      if (kept) return;
      // While the first stale document is removed, the user uploads the other one
      // again (a dedupe hit) and attaches it to a bill.
      const other = key.endsWith(a.id) ? b : a;
      kept = other.id;
      const again = await storeDocument(
        u.id,
        other === a ? pdf("a") : pdf("b"),
        "again.pdf",
        "x",
      );
      expect(again.id).toBe(other.id);
      await attachDocument(u.id, bill.id, other.id);
    });
    expect(await sweepUnreferencedDocuments(u.id)).toBe(1);
    vi.restoreAllMocks();
    expect((await getDocumentMeta(u.id, kept)).id).toBe(kept);
    expect((await readDocument(u.id, kept)).bytes.byteLength).toBeGreaterThan(
      0,
    );
    expect((await getBill(u.id, bill.id)).documentId).toBe(kept);
  });

  it("re-inserts a document that was deleted while its dedupe hit was being checked", async () => {
    const u = await createTestUser();
    const first = await storeDocument(u.id, pdf("same"), "a.pdf", "x");
    const realHas = blobs.store.has.bind(blobs.store);
    vi.spyOn(blobs.store, "has").mockImplementation(async (key) => {
      const found = await realHas(key);
      await deleteDocument(u.id, first.id);
      return found;
    });
    const again = await storeDocument(u.id, pdf("same"), "a.pdf", "x");
    vi.restoreAllMocks();
    expect(again.id).not.toBe(first.id);
    expect((await readDocument(u.id, again.id)).bytes.byteLength).toBe(
      pdf("same").byteLength,
    );
    expect(await keys()).toEqual([`documents/${u.id}/${again.id}`]);
  });

  it("deletes a document only while the condition still holds, and only for its owner", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const doc = await storeDocument(u.id, pdf("cond"), "a.pdf", "x");
    const key = `documents/${u.id}/${doc.id}`;
    expect(
      await deleteDocumentWhere(
        u.id,
        doc.id,
        eq(documents.source, "integration"),
      ),
    ).toBe(false);
    expect(await deleteDocumentWhere(other.id, doc.id)).toBe(false);
    expect((await getDocumentMeta(u.id, doc.id)).id).toBe(doc.id);
    expect(await blobs.store.has(key)).toBe(true);

    expect(
      await deleteDocumentWhere(u.id, doc.id, eq(documents.source, "upload")),
    ).toBe(true);
    await expect(getDocumentMeta(u.id, doc.id)).rejects.toThrow(LedgerError);
    expect(await blobs.store.has(key)).toBe(false);
    expect(await deleteDocumentWhere(u.id, doc.id)).toBe(false);
    await expect(deleteDocument(u.id, doc.id)).rejects.toThrow(LedgerError);
  });

  it("restores a missing blob of a deduped upload as application/pdf", async () => {
    const u = await createTestUser();
    const doc = await storeDocument(u.id, pdf("r"), "a.pdf", "x");
    await blobs.store.delete(`documents/${u.id}/${doc.id}`);
    const put = vi.spyOn(blobs.store, "put");
    await storeDocument(u.id, pdf("r"), "a.pdf", "text/plain");
    expect(put).toHaveBeenCalledWith(
      `documents/${u.id}/${doc.id}`,
      expect.anything(),
      "application/pdf",
    );
    vi.restoreAllMocks();
  });

  it("reads a bill whose stored extraction is corrupt", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    await getDB()
      .update(bills)
      .set({ extraction: "{not json" })
      .where(eq(bills.id, bill.id));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await getBill(u.id, bill.id)).extraction).toBeNull();
    warn.mockRestore();
  });

  it("does not expose another user's document", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const doc = await storeDocument(
      a.id,
      pdf("secret"),
      "a.pdf",
      "application/pdf",
    );
    await expect(readDocument(b.id, doc.id)).rejects.toThrow(LedgerError);
    await expect(getDocumentMeta(b.id, doc.id)).rejects.toThrow(LedgerError);
    await expect(deleteDocument(b.id, doc.id)).rejects.toThrow(LedgerError);
    expect(await blobs.store.has(`documents/${a.id}/${doc.id}`)).toBe(true);
  });

  it("deleting a document keeps the bill, with no document", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    const doc = await storeDocument(u.id, pdf("d"), "a.pdf", "application/pdf");
    await attachDocument(u.id, bill.id, doc.id);
    expect((await getBill(u.id, bill.id)).documentId).toBe(doc.id);
    await deleteDocument(u.id, doc.id);
    expect((await getBill(u.id, bill.id)).documentId).toBeNull();
    expect(await keys()).toEqual([]);
  });

  it("replacing or deleting removes an unused uploaded document", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    const d1 = await storeDocument(u.id, pdf("1"), "a.pdf", "application/pdf");
    const d2 = await storeDocument(u.id, pdf("2"), "b.pdf", "application/pdf");
    await attachDocument(u.id, bill.id, d1.id);
    await attachDocument(u.id, bill.id, d2.id);
    await expect(getDocumentMeta(u.id, d1.id)).rejects.toThrow(LedgerError);
    expect(await keys()).toEqual([`documents/${u.id}/${d2.id}`]);
    await deleteBill(u.id, bill.id);
    await expect(getDocumentMeta(u.id, d2.id)).rejects.toThrow(LedgerError);
    expect(await keys()).toEqual([]);
  });

  it("keeps a document that another bill still uses", async () => {
    const u = await createTestUser();
    const one = await seedBill(u.id);
    const two = await seedBill(u.id);
    const d = await storeDocument(
      u.id,
      pdf("shared"),
      "a.pdf",
      "application/pdf",
    );
    await attachDocument(u.id, one.id, d.id);
    await attachDocument(u.id, two.id, d.id);
    await deleteBill(u.id, one.id);
    expect((await getDocumentMeta(u.id, d.id)).id).toBe(d.id);
    expect(await blobs.store.has(`documents/${u.id}/${d.id}`)).toBe(true);
  });

  it("cannot attach another user's document to a bill", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const doc = await storeDocument(a.id, pdf("z"), "a.pdf", "application/pdf");
    const bill = await seedBill(b.id);
    await expect(attachDocument(b.id, bill.id, doc.id)).rejects.toThrow(
      LedgerError,
    );
  });
});

describe("documents stored by earlier versions", () => {
  useTestDB();
  let dir: string | null = null;
  afterEach(() => {
    setStore(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("stay readable at the same path with the default storage configuration", async () => {
    dir = mkdtempSync(join(tmpdir(), "kept-legacy-"));
    const u = await createTestUser();
    const id = crypto.randomUUID();
    const bytes = pdf("legacy");
    // Layout of earlier versions: <dirname(DATABASE_PATH)>/documents/<userId>/<id>
    mkdirSync(join(dir, "documents", u.id), { recursive: true });
    writeFileSync(join(dir, "documents", u.id, id), bytes);
    await getDB()
      .insert(documents)
      .values({
        id,
        userId: u.id,
        fileName: "old.pdf",
        mimeType: "application/pdf",
        size: bytes.byteLength,
        sha256: "0".repeat(64),
        storageKey: join(u.id, id),
        source: "upload",
      });

    // Only DATABASE_PATH is set, as on an install that predates KEPT_STORAGE_DIR.
    setStore(
      createStore(readStorageConfig({ DATABASE_PATH: join(dir, "kept.db") })),
    );

    const read = await readDocument(u.id, id);
    expect(read.bytes).toEqual(bytes);
    expect(read.meta.fileName).toBe("old.pdf");

    const next = await storeDocument(u.id, pdf("new"), "n.pdf", "x");
    const [row] = await getDB()
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, next.id));
    expect(row?.storageKey).toBe(`${u.id}/${next.id}`);
    expect(await Bun.file(join(dir, "documents", u.id, next.id)).exists()).toBe(
      true,
    );

    await deleteDocument(u.id, id);
    expect(await Bun.file(join(dir, "documents", u.id, id)).exists()).toBe(
      false,
    );
  });
});
