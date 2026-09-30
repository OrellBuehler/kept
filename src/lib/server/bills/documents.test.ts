import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestDocuments } from "$lib/testing/documents";
import { LedgerError } from "$lib/server/ledger/errors";
import { bills, documents, getDB } from "$lib/server/db";
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
  const store = useTestDocuments();

  it("stores a PDF under the user's directory and reads it back", async () => {
    const u = await createTestUser();
    const doc = storeDocument(u.id, pdf("a"), "bill.pdf", "text/plain");
    expect(doc).toMatchObject({
      fileName: "bill.pdf",
      mimeType: "application/pdf",
      source: "upload",
    });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(store.dir, u.id, doc.id))).toBe(true);
    const read = readDocument(u.id, doc.id);
    expect(new TextDecoder().decode(read.bytes)).toContain("%PDF-1.4");
    expect(read.meta.size).toBe(pdf("a").byteLength);
  });

  it("rejects files that are not PDFs by content, empty or too large", async () => {
    const u = await createTestUser();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof LedgerError) return `${e.code}:${e.field}`;
        throw e;
      }
      return "none";
    };
    const text = new TextEncoder().encode("hello");
    expect(
      code(() => storeDocument(u.id, text, "x.pdf", "application/pdf")),
    ).toBe("invalid:file");
    expect(
      code(() =>
        storeDocument(u.id, new Uint8Array(), "x.pdf", "application/pdf"),
      ),
    ).toBe("invalid:file");
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(pdf());
    expect(
      code(() => storeDocument(u.id, big, "x.pdf", "application/pdf")),
    ).toBe("invalid:file");
    const exact = new Uint8Array(MAX_DOCUMENT_BYTES);
    exact.set(pdf());
    expect(
      code(() => storeDocument(u.id, exact, "x.pdf", "application/pdf")),
    ).toBe("none");
    expect(getDB().select().from(documents).all()).toHaveLength(1);
  });

  it("returns the existing document for identical content of the same user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const first = storeDocument(
      a.id,
      pdf("same"),
      "one.pdf",
      "application/pdf",
    );
    const again = storeDocument(
      a.id,
      pdf("same"),
      "two.pdf",
      "application/pdf",
    );
    expect(again.id).toBe(first.id);
    expect(again.fileName).toBe("one.pdf");
    const other = storeDocument(
      b.id,
      pdf("same"),
      "one.pdf",
      "application/pdf",
    );
    expect(other.id).not.toBe(first.id);
    expect(readdirSync(join(store.dir, a.id))).toHaveLength(1);
  });

  it("restores a missing file when the same content is uploaded again", async () => {
    const u = await createTestUser();
    const doc = storeDocument(u.id, pdf("x"), "a.pdf", "application/pdf");
    deleteFileOnly(store.dir, u.id, doc.id);
    expect(() => readDocument(u.id, doc.id)).toThrow(LedgerError);
    storeDocument(u.id, pdf("x"), "a.pdf", "application/pdf");
    expect(readDocument(u.id, doc.id).bytes.byteLength).toBeGreaterThan(0);
  });

  it("never lets the file name influence the storage path", async () => {
    const u = await createTestUser();
    const doc = storeDocument(
      u.id,
      pdf("p"),
      "../../etc/passwd\u0000.pdf",
      "application/pdf",
    );
    expect(doc.fileName).toBe("passwd.pdf");
    expect(readdirSync(join(store.dir, u.id))).toEqual([doc.id]);
    expect(sanitizeFileName("..")).toBe("document.pdf");
    expect(sanitizeFileName("a\\b\\c.pdf")).toBe("c.pdf");
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(200);
  });

  it("checks the PDF signature at the start, allowing leading whitespace", async () => {
    const u = await createTestUser();
    const enc = (t: string) => new TextEncoder().encode(t);
    expect(() =>
      storeDocument(u.id, enc("\n \r%PDF-1.4"), "a.pdf", "x"),
    ).not.toThrow();
    expect(() =>
      storeDocument(u.id, enc("junk%PDF-1.4"), "b.pdf", "x"),
    ).toThrow(LedgerError);
    expect(hasPdfMagic(enc("<html>%PDF-"))).toBe(false);
  });

  it("sweeps old unreferenced uploads only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const bill = seedBill(u.id);
    const old = storeDocument(u.id, pdf("old"), "a.pdf", "x");
    const used = storeDocument(u.id, pdf("used"), "b.pdf", "x");
    const fresh = storeDocument(u.id, pdf("fresh"), "c.pdf", "x");
    const foreign = storeDocument(other.id, pdf("old"), "d.pdf", "x");
    attachDocument(u.id, bill.id, used.id);
    const dayAndAbit = Date.now() - 25 * 3600 * 1000;
    for (const id of [old.id, used.id, foreign.id]) {
      getDB()
        .update(documents)
        .set({ createdAt: new Date(dayAndAbit) })
        .where(eq(documents.id, id))
        .run();
    }
    expect(sweepUnreferencedDocuments(u.id)).toBe(1);
    expect(() => getDocumentMeta(u.id, old.id)).toThrow(LedgerError);
    expect(existsSync(join(store.dir, u.id, old.id))).toBe(false);
    expect(getDocumentMeta(u.id, used.id).id).toBe(used.id);
    expect(getDocumentMeta(u.id, fresh.id).id).toBe(fresh.id);
    expect(getDocumentMeta(other.id, foreign.id).id).toBe(foreign.id);
  });

  it("reads a bill whose stored extraction is corrupt", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id);
    getDB()
      .update(bills)
      .set({ extraction: "{not json" })
      .where(eq(bills.id, bill.id))
      .run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getBill(u.id, bill.id).extraction).toBeNull();
    warn.mockRestore();
  });

  it("does not expose another user's document", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const doc = storeDocument(a.id, pdf("secret"), "a.pdf", "application/pdf");
    expect(() => readDocument(b.id, doc.id)).toThrow(LedgerError);
    expect(() => getDocumentMeta(b.id, doc.id)).toThrow(LedgerError);
    expect(() => deleteDocument(b.id, doc.id)).toThrow(LedgerError);
    expect(existsSync(join(store.dir, a.id, doc.id))).toBe(true);
  });

  it("deleting a document keeps the bill, with no document", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id);
    const doc = storeDocument(u.id, pdf("d"), "a.pdf", "application/pdf");
    attachDocument(u.id, bill.id, doc.id);
    expect(getBill(u.id, bill.id).documentId).toBe(doc.id);
    deleteDocument(u.id, doc.id);
    expect(getBill(u.id, bill.id).documentId).toBeNull();
    expect(existsSync(join(store.dir, u.id, doc.id))).toBe(false);
  });

  it("replacing or deleting removes an unused uploaded document", async () => {
    const u = await createTestUser();
    const bill = seedBill(u.id);
    const d1 = storeDocument(u.id, pdf("1"), "a.pdf", "application/pdf");
    const d2 = storeDocument(u.id, pdf("2"), "b.pdf", "application/pdf");
    attachDocument(u.id, bill.id, d1.id);
    attachDocument(u.id, bill.id, d2.id);
    expect(() => getDocumentMeta(u.id, d1.id)).toThrow(LedgerError);
    deleteBill(u.id, bill.id);
    expect(() => getDocumentMeta(u.id, d2.id)).toThrow(LedgerError);
  });

  it("keeps a document that another bill still uses", async () => {
    const u = await createTestUser();
    const one = seedBill(u.id);
    const two = seedBill(u.id);
    const d = storeDocument(u.id, pdf("shared"), "a.pdf", "application/pdf");
    attachDocument(u.id, one.id, d.id);
    attachDocument(u.id, two.id, d.id);
    deleteBill(u.id, one.id);
    expect(getDocumentMeta(u.id, d.id).id).toBe(d.id);
  });

  it("cannot attach another user's document to a bill", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const doc = storeDocument(a.id, pdf("z"), "a.pdf", "application/pdf");
    const bill = seedBill(b.id);
    expect(() => attachDocument(b.id, bill.id, doc.id)).toThrow(LedgerError);
  });
});

import { rmSync } from "node:fs";
function deleteFileOnly(dir: string, userId: string, id: string) {
  rmSync(join(dir, userId, id));
}
