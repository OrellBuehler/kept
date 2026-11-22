import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { runAsActor, type Actor } from "$lib/server/audit/context";
import { listChanges } from "$lib/server/audit/list";
import { revertChange } from "$lib/server/audit/revert";
import { documents, getDB } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { attachDocument, deleteBill, getBill } from "./bills";
import { getDocumentMeta, storeDocument } from "./documents";
import {
  HELD_DOCUMENT_TTL_MS,
  registerHeldDocumentSweep,
  sweepHeldDocuments,
  unregisterHeldDocumentSweep,
} from "./held-documents";
import { sweepUnreferencedDocuments } from "./bills";

const pdf = (extra: string) =>
  new TextEncoder().encode(`%PDF-1.4\n${extra}\n%%EOF`);

afterEach(() => unregisterHeldDocumentSweep());

const asConnection = <T>(userId: string, kind: "mcp" | "api", fn: () => T): T =>
  runAsActor({ kind, userId, tokenId: "t-1", label: "x" } as Actor, fn);

async function billWithDocument(userId: string, tag: string) {
  const bill = await seedBill(userId);
  const doc = await storeDocument(userId, pdf(tag), "bill.pdf", "text/plain");
  await attachDocument(userId, bill.id, doc.id);
  return { bill, doc };
}

const heldUntil = async (id: string) =>
  (
    await getDB()
      .select({ heldUntil: documents.heldUntil })
      .from(documents)
      .where(eq(documents.id, id))
  )[0]?.heldUntil ?? null;

describe("bill delete and its document", () => {
  useTestDB();
  const blobs = useTestStore();
  const keys = async () =>
    (await Array.fromAsync(blobs.store.list(""))).map((i) => i.key);

  it("removes the document at once when the owner deletes the bill on the web", async () => {
    const u = await createTestUser();
    const { bill, doc } = await billWithDocument(u.id, "web");
    await runAsActor({ kind: "web", userId: u.id }, () =>
      deleteBill(u.id, bill.id),
    );
    expect(await getDocumentMeta(u.id, doc.id).catch(() => null)).toBeNull();
    expect(await keys()).toEqual([]);
  });

  it.each(["mcp", "api"] as const)(
    "keeps the document and its file when a %s connection deletes the bill, and undoing the delete attaches it again",
    async (kind) => {
      const u = await createTestUser();
      const { bill, doc } = await billWithDocument(u.id, kind);
      const before = Date.now();
      await asConnection(u.id, kind, () => deleteBill(u.id, bill.id));

      expect((await getDocumentMeta(u.id, doc.id)).id).toBe(doc.id);
      expect(await keys()).toHaveLength(1);
      const until = (await heldUntil(doc.id))!;
      expect(until.getTime()).toBeGreaterThanOrEqual(
        before + HELD_DOCUMENT_TTL_MS,
      );

      const entry = (await listChanges(u.id, { limit: 1 })).items[0]!;
      expect(entry.action).toBe("bill.delete");
      const result = await revertChange(u.id, entry.id);
      expect(result.warnings).toEqual([]);
      expect((await getBill(u.id, bill.id)).documentId).toBe(doc.id);
      expect(await heldUntil(doc.id)).toBeNull();
      expect(await keys()).toHaveLength(1);
    },
  );

  it("says the document is gone when it was deleted before the undo", async () => {
    const u = await createTestUser();
    const { bill, doc } = await billWithDocument(u.id, "gone");
    await asConnection(u.id, "mcp", () => deleteBill(u.id, bill.id));
    await getDB().delete(documents).where(eq(documents.id, doc.id));
    const entry = (await listChanges(u.id, { limit: 1 })).items[0]!;
    const result = await revertChange(u.id, entry.id);
    expect(result.warnings.join(" ")).toMatch(/document/);
    expect((await getBill(u.id, bill.id)).documentId).toBeNull();
  });

  it("never re-attaches another user's document", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const { bill, doc } = await billWithDocument(u.id, "mine");
    await asConnection(u.id, "mcp", () => deleteBill(u.id, bill.id));
    // The held row now belongs to someone else (tampered data): the undo must not use it.
    await getDB()
      .update(documents)
      .set({ userId: other.id })
      .where(eq(documents.id, doc.id));
    const entry = (await listChanges(u.id, { limit: 1 })).items[0]!;
    const result = await revertChange(u.id, entry.id);
    expect(result.warnings.join(" ")).toMatch(/document/);
    expect((await getBill(u.id, bill.id)).documentId).toBeNull();
  });
});

describe("the sweep of held documents", () => {
  useTestDB();
  const blobs = useTestStore();
  const keys = async () =>
    (await Array.fromAsync(blobs.store.list(""))).map((i) => i.key);

  it("keeps a held document until its time is up, then removes row and file", async () => {
    const u = await createTestUser();
    const { bill, doc } = await billWithDocument(u.id, "sweep");
    await asConnection(u.id, "mcp", () => deleteBill(u.id, bill.id));

    expect(await sweepHeldDocuments(Date.now() + 29 * 24 * 3_600_000)).toBe(0);
    expect(await keys()).toHaveLength(1);

    expect(await sweepHeldDocuments(Date.now() + 31 * 24 * 3_600_000)).toBe(1);
    expect(await keys()).toEqual([]);
    expect(await heldUntil(doc.id)).toBeNull();
    expect(await getDocumentMeta(u.id, doc.id).catch(() => null)).toBeNull();
  });

  it("is not triggered by the abandoned-upload sweep, however old the document is", async () => {
    const u = await createTestUser();
    const { bill, doc } = await billWithDocument(u.id, "abandoned");
    await getDB()
      .update(documents)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 3_600_000) })
      .where(eq(documents.id, doc.id));
    await asConnection(u.id, "api", () => deleteBill(u.id, bill.id));
    expect(await sweepUnreferencedDocuments(u.id)).toBe(0);
    expect(await keys()).toHaveLength(1);
  });

  it("never deletes a document a bill references again, and lifts its hold", async () => {
    const u = await createTestUser();
    const { bill, doc } = await billWithDocument(u.id, "again");
    await asConnection(u.id, "mcp", () => deleteBill(u.id, bill.id));
    const another = await seedBill(u.id);
    await attachDocument(u.id, another.id, doc.id);

    expect(await sweepHeldDocuments(Date.now() + 40 * 24 * 3_600_000)).toBe(0);
    expect(await keys()).toHaveLength(1);
    expect((await getBill(u.id, another.id)).documentId).toBe(doc.id);
    expect(await heldUntil(doc.id)).toBeNull();
  });

  it("sweeps every user's held documents and leaves other documents alone", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const one = await billWithDocument(a.id, "a");
    const two = await billWithDocument(b.id, "b");
    const kept = await billWithDocument(b.id, "kept");
    await asConnection(a.id, "mcp", () => deleteBill(a.id, one.bill.id));
    await asConnection(b.id, "api", () => deleteBill(b.id, two.bill.id));
    expect(await sweepHeldDocuments(Date.now() + 31 * 24 * 3_600_000)).toBe(2);
    expect(await keys()).toHaveLength(1);
    expect((await getBill(b.id, kept.bill.id)).documentId).toBe(kept.doc.id);
  });

  it("can be scheduled and stopped once", () => {
    registerHeldDocumentSweep({ intervalMs: 3_600_000, firstRunDelayMs: 1e9 });
    registerHeldDocumentSweep();
    unregisterHeldDocumentSweep();
  });
});
