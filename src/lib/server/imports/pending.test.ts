import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount } from "$lib/testing/ledger";
import { useTestStore } from "$lib/testing/store";
import { accounts, getDB, pendingImports, users } from "$lib/server/db";
import { fixture } from "$lib/testing/fixtures";

import { LedgerError } from "$lib/server/ledger/errors";
import {
  deletePending,
  deletePendingRow,
  detectFormat,
  getPendingMeta,
  MAX_UPLOAD_BYTES,
  pendingBlobKey,
  PENDING_TTL_MS,
  purgeExpired,
  readPending,
  startPendingSweep,
  storePending,
  sweepOrphanedPending,
} from "./pending";

useTestDB();
const ctx = useTestStore();
const enc = (s: string) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("detects camt.053 by content, whatever the file name", () => {
    expect(detectFormat(fixture("camt053/v04-basic.xml"))).toBe("camt053");
    expect(detectFormat(fixture("camt053/v08-basic.xml"))).toBe("camt053");
  });

  it("detects camt.053 behind a UTF-8 BOM", () => {
    const xml = fixture("camt053/v04-basic.xml");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...xml]);
    expect(detectFormat(withBom)).toBe("camt053");
  });

  it("detects xlsx by the zip magic", () => {
    expect(detectFormat(fixture("xlsx/statement.xlsx"))).toBe("xlsx");
  });

  it("treats other text as csv", () => {
    expect(detectFormat(fixture("csv/comma-dot.csv"))).toBe("csv");
    expect(detectFormat(fixture("csv/utf16le-bom.csv"))).toBe("csv");
  });

  it("rejects camt.054 and other XML with a clear message", () => {
    const xml054 = enc(
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08"><BkToCstmrDbtCdtNtfctn/></Document>',
    );
    const pain = enc(
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"/>',
    );
    for (const bytes of [xml054, pain]) {
      expect(() => detectFormat(bytes)).toThrow(/not a camt\.053/);
    }
  });

  it("rejects empty files", () => {
    expect(() => detectFormat(new Uint8Array())).toThrow(LedgerError);
  });
});

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id);
  return { user, account };
}

const store = (userId: string, accountId: string, name = "a.csv") =>
  storePending(userId, {
    accountId,
    fileName: name,
    bytes: enc("a,b\n1,2\n"),
  });

const expire = (id: string, at: number) =>
  getDB()
    .update(pendingImports)
    .set({ expiresAt: new Date(at) })
    .where(eq(pendingImports.id, id))
    .run();

async function blobKeys() {
  const keys: string[] = [];
  for await (const b of ctx.store.list("pending-imports/")) keys.push(b.key);
  return keys;
}

describe("pending uploads", () => {
  it("stores bytes in the blob store and metadata in the table", async () => {
    const { user, account } = await setup();
    const meta = await storePending(user.id, {
      accountId: account.id,
      fileName: "../../etc/statement.csv",
      bytes: fixture("csv/comma-dot.csv"),
    });
    expect(meta.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(meta.fileName).toBe("statement.csv");
    expect(meta.format).toBe("csv");
    expect(meta.accountId).toBe(account.id);
    expect(meta.size).toBe(fixture("csv/comma-dot.csv").length);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.expiresAt - meta.createdAt).toBe(PENDING_TTL_MS);
    expect(await blobKeys()).toEqual([`pending-imports/${user.id}/${meta.id}`]);
    const read = await readPending(user.id, meta.id);
    expect(read.bytes).toEqual(fixture("csv/comma-dot.csv"));
    expect(read.meta).toEqual(meta);
    expect(getPendingMeta(user.id, meta.id)).toEqual(meta);
  });

  it("generates distinct unguessable ids", async () => {
    const { user, account } = await setup();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await store(user.id, account.id)).id);
    expect(ids.size).toBe(20);
  });

  it("rejects files over 20 MB and empty files, storing nothing", async () => {
    const { user, account } = await setup();
    await expect(
      storePending(user.id, {
        accountId: account.id,
        fileName: "big.csv",
        bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(97),
      }),
    ).rejects.toThrow(/larger than 20 MB/);
    await expect(
      storePending(user.id, {
        accountId: account.id,
        fileName: "e.csv",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow(/empty/);
    expect(await blobKeys()).toEqual([]);
    expect(getDB().select().from(pendingImports).all()).toEqual([]);
  });

  it("removes the blob when the row cannot be written", async () => {
    const { user } = await setup();
    await expect(store(user.id, "no-such-account")).rejects.toThrow();
    expect(await blobKeys()).toEqual([]);
  });

  it("treats malformed ids as not found without touching the store", async () => {
    const { user } = await setup();
    for (const id of ["../x", "..%2Fx", "a/b", "short", "", "a".repeat(33)]) {
      expect(() => getPendingMeta(user.id, id)).toThrow(LedgerError);
      await expect(readPending(user.id, id)).rejects.toThrow(LedgerError);
      await expect(deletePending(user.id, id)).rejects.toThrow(LedgerError);
    }
  });

  it("is invisible to other users", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const meta = await store(user.id, account.id);
    expect(() => getPendingMeta(other.id, meta.id)).toThrow(/not found/);
    await expect(readPending(other.id, meta.id)).rejects.toThrow(/not found/);
    await expect(deletePending(other.id, meta.id)).rejects.toThrow(/not found/);
    expect(await ctx.store.has(pendingBlobKey(user.id, meta.id))).toBe(true);
    expect((await readPending(user.id, meta.id)).meta.id).toBe(meta.id);
  });

  it("a row of another user does not expose the blob under this user's key", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const meta = await store(user.id, account.id);
    await ctx.store.put(pendingBlobKey(other.id, meta.id), enc("x,y\n"));
    await expect(readPending(other.id, meta.id)).rejects.toThrow(/not found/);
  });

  it("is not found when the blob is missing", async () => {
    const { user, account } = await setup();
    const meta = await store(user.id, account.id);
    await ctx.store.delete(pendingBlobKey(user.id, meta.id));
    await expect(readPending(user.id, meta.id)).rejects.toThrow(/not found/);
  });

  it("delete removes the row and the blob", async () => {
    const { user, account } = await setup();
    const meta = await store(user.id, account.id);
    await deletePending(user.id, meta.id);
    expect(await blobKeys()).toEqual([]);
    expect(getDB().select().from(pendingImports).all()).toEqual([]);
    await expect(readPending(user.id, meta.id)).rejects.toThrow(/not found/);
  });

  it("deletePendingRow reports whether it removed a row", async () => {
    const { user, account } = await setup();
    const meta = await store(user.id, account.id);
    expect(deletePendingRow(user.id, meta.id)).toBe(true);
    expect(deletePendingRow(user.id, meta.id)).toBe(false);
  });

  it("is gone after two hours, even before it is purged", async () => {
    const { user, account } = await setup();
    const meta = await store(user.id, account.id);
    expect(() =>
      getPendingMeta(user.id, meta.id, meta.expiresAt),
    ).not.toThrow();
    expect(() => getPendingMeta(user.id, meta.id, meta.expiresAt + 1)).toThrow(
      /not found/,
    );
  });

  it("cascades with the account and the user", async () => {
    const { user, account } = await setup();
    const other = seedAccount(user.id, { name: "Other" });
    await store(user.id, account.id);
    const kept = await store(user.id, other.id);
    getDB().delete(accounts).where(eq(accounts.id, account.id)).run();
    expect(getDB().select().from(pendingImports).all()).toHaveLength(1);
    getDB().delete(users).where(eq(users.id, user.id)).run();
    expect(getDB().select().from(pendingImports).all()).toEqual([]);
    // the blob is left for the orphan sweep
    expect(await ctx.store.has(pendingBlobKey(user.id, kept.id))).toBe(true);
  });
});

describe("purgeExpired", () => {
  it("removes expired rows and blobs of every user and keeps fresh ones", async () => {
    const a = await setup();
    const b = await setup();
    const old = await store(a.user.id, a.account.id);
    const fresh = await store(b.user.id, b.account.id);
    expire(old.id, Date.now() - 1000);
    await purgeExpired();
    expect(await blobKeys()).toEqual([pendingBlobKey(b.user.id, fresh.id)]);
    expect(
      getDB().select({ id: pendingImports.id }).from(pendingImports).all(),
    ).toEqual([{ id: fresh.id }]);
  });

  it("an upload purges expired uploads", async () => {
    const { user, account } = await setup();
    const old = await store(user.id, account.id);
    expire(old.id, Date.now() - 1000);
    const next = await store(user.id, account.id);
    expect(await blobKeys()).toEqual([pendingBlobKey(user.id, next.id)]);
  });

  it("keeps the row when its blob cannot be deleted, so the next purge retries", async () => {
    const { user, account } = await setup();
    const old = await store(user.id, account.id);
    expire(old.id, Date.now() - 1000);
    const realDelete = ctx.store.delete.bind(ctx.store);
    ctx.store.delete = () => Promise.reject(new Error("offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await purgeExpired();
      expect(getDB().select().from(pendingImports).all()).toHaveLength(1);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain("offline");
    } finally {
      log.mockRestore();
      ctx.store.delete = realDelete;
    }
    await purgeExpired();
    expect(getDB().select().from(pendingImports).all()).toEqual([]);
    expect(await blobKeys()).toEqual([]);
  });
});

describe("sweepOrphanedPending", () => {
  /** The clock after every blob written by the test has outlived the TTL. */
  const later = () => Date.now() + PENDING_TTL_MS + 60_000;

  it("removes old blobs without a row, including the old sidecar layout, and keeps owned ones", async () => {
    const { user, account } = await setup();
    const owned = await store(user.id, account.id);
    const oldId = "o".repeat(32);
    const other = await createTestUser();
    // Blobs of the previous layout: data file plus `<id>.json` sidecar.
    await ctx.store.put(`pending-imports/${user.id}/${oldId}`, enc("x"));
    await ctx.store.put(`pending-imports/${user.id}/${oldId}.json`, enc("{}"));
    // A row of another user does not own this user's key.
    await ctx.store.put(pendingBlobKey(other.id, owned.id), enc("x"));
    await ctx.store.put("pending-imports/stray", enc("x"));
    expect(await sweepOrphanedPending(later())).toBe(4);
    expect(await blobKeys()).toEqual([pendingBlobKey(user.id, owned.id)]);
  });

  it("never touches a blob younger than the TTL", async () => {
    const { user } = await setup();
    await ctx.store.put(
      `pending-imports/${user.id}/${"n".repeat(32)}`,
      enc("x"),
    );
    expect(await sweepOrphanedPending()).toBe(0);
    expect(await blobKeys()).toHaveLength(1);
  });

  it("leaves other prefixes alone", async () => {
    await ctx.store.put("documents/u/d", enc("x"));
    await ctx.store.put("documents/u/old", enc("x"));
    expect(await sweepOrphanedPending(later())).toBe(0);
    expect(await ctx.store.has("documents/u/d")).toBe(true);
  });

  it("startPendingSweep purges expired uploads in the background", async () => {
    const { user, account } = await setup();
    const old = await store(user.id, account.id);
    expire(old.id, Date.now() - 1000);
    startPendingSweep();
    await vi.waitFor(async () => expect(await blobKeys()).toEqual([]));
    expect(getDB().select().from(pendingImports).all()).toEqual([]);
  });
});
