import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { uploadFixture, usePendingDir } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { cachedParse, clearParseCache, parseCacheSize } from "./cache";
import { pendingRoot, type PendingMeta } from "./pending";
import { buildPreview } from "./preview";

useTestDB();
usePendingDir();

const meta = (id: string): PendingMeta => ({
  id: id.padEnd(32, "x"),
  userId: "u",
  accountId: "a",
  fileName: "f",
  format: "csv",
  size: 1,
  sha256: "0".repeat(64),
  createdAt: 0,
});

describe("parse cache", () => {
  it("computes once per key and keeps at most 4 entries (LRU)", () => {
    clearParseCache();
    let calls = 0;
    const get = (id: string) =>
      cachedParse(meta(id), "v", () => {
        calls++;
        return id;
      });
    get("a");
    get("a");
    expect(calls).toBe(1);
    for (const id of ["b", "c", "d", "e"]) get(id);
    expect(parseCacheSize()).toBe(4);
    get("a");
    expect(calls).toBe(6);
  });

  it("does not cache failures", () => {
    clearParseCache();
    expect(() =>
      cachedParse(meta("f"), "v", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(parseCacheSize()).toBe(0);
  });

  it("a repeated preview does not re-read or re-parse the file", async () => {
    clearParseCache();
    const user = await createTestUser();
    const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const id = uploadFixture(user.id, account.id, "camt053/overlap-a.xml");
    const first = buildPreview(user.id, id);
    rmSync(join(pendingRoot(), user.id, id));
    const second = buildPreview(user.id, id);
    expect(second.rows).toEqual(first.rows);
  });
});
