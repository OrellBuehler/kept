import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { uploadFixture } from "$lib/testing/imports";
import { useTestStore } from "$lib/testing/store";
import { seedAccount } from "$lib/testing/ledger";
import { cachedParse, clearParseCache, parseCacheSize } from "./cache";
import { pendingBlobKey, type PendingMeta } from "./pending";
import { buildPreview } from "./preview";

useTestDB();
const ctx = useTestStore();

const meta = (id: string): PendingMeta => ({
  id: id.padEnd(32, "x"),
  userId: "u",
  accountId: "a",
  fileName: "f",
  format: "csv",
  size: 1,
  sha256: "0".repeat(64),
  createdAt: 0,
  expiresAt: 1,
});

describe("parse cache", () => {
  it("computes once per key and keeps at most 4 entries (LRU)", async () => {
    clearParseCache();
    let calls = 0;
    const get = (id: string) =>
      cachedParse(meta(id), "v", () => {
        calls++;
        return id;
      });
    await get("a");
    await get("a");
    expect(calls).toBe(1);
    for (const id of ["b", "c", "d", "e"]) await get(id);
    expect(parseCacheSize()).toBe(4);
    await get("a");
    expect(calls).toBe(6);
  });

  it("does not cache failures", async () => {
    clearParseCache();
    await expect(
      cachedParse(meta("f"), "v", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(parseCacheSize()).toBe(0);
  });

  it("a repeated preview does not re-read or re-parse the file", async () => {
    clearParseCache();
    const user = await createTestUser();
    const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    const first = await buildPreview(user.id, id);
    await ctx.store.delete(pendingBlobKey(user.id, id));
    const second = await buildPreview(user.id, id);
    expect(second.rows).toEqual(first.rows);
  });
});
