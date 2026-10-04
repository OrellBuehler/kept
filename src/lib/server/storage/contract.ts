import { describe, expect, it } from "vitest";
import type { BlobStore } from "./blob-store";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) =>
  data === null ? null : new TextDecoder().decode(data);

async function keys(store: BlobStore, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const info of store.list(prefix)) out.push(info.key);
  return out;
}

/** Behaviour every BlobStore must have; run it against each implementation. */
export function blobStoreContract(
  name: string,
  make: () => Promise<{ store: BlobStore; cleanup?: () => Promise<void> }>,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    async function withStore(
      fn: (store: BlobStore) => Promise<void>,
    ): Promise<void> {
      const { store, cleanup } = await make();
      try {
        await fn(store);
      } finally {
        await cleanup?.();
      }
    }

    it("reads back what was written, including binary bytes", () =>
      withStore(async (s) => {
        const all = Uint8Array.from({ length: 256 }, (_, i) => i);
        await s.put("documents/u1/a", all, "application/pdf");
        expect(await s.get("documents/u1/a")).toEqual(all);
        expect(await s.has("documents/u1/a")).toBe(true);
      }));

    it("returns null and false for a missing key", () =>
      withStore(async (s) => {
        expect(await s.get("documents/u1/none")).toBeNull();
        expect(await s.has("documents/u1/none")).toBe(false);
        await s.put("documents/u1/a", bytes("x"));
        expect(await s.get("documents/u1/a/deeper")).toBeNull();
        expect(await s.has("documents/u1")).toBe(false);
      }));

    it("stores empty content", () =>
      withStore(async (s) => {
        await s.put("k", new Uint8Array());
        expect(await s.has("k")).toBe(true);
        expect((await s.get("k"))?.byteLength).toBe(0);
      }));

    it("overwrites an existing key", () =>
      withStore(async (s) => {
        await s.put("k", bytes("one"));
        await s.put("k", bytes("two!"));
        expect(text(await s.get("k"))).toBe("two!");
        const listed: number[] = [];
        for await (const i of s.list("k")) listed.push(i.size);
        expect(listed).toEqual([4]);
      }));

    it("does not alias the caller's bytes", () =>
      withStore(async (s) => {
        const input = bytes("abc");
        await s.put("k", input);
        input[0] = 0;
        const out = await s.get("k");
        expect(text(out)).toBe("abc");
        out![1] = 0;
        expect(text(await s.get("k"))).toBe("abc");
      }));

    it("deletes idempotently", () =>
      withStore(async (s) => {
        await s.put("a/b", bytes("x"));
        await s.delete("a/b");
        expect(await s.has("a/b")).toBe(false);
        await s.delete("a/b");
        await s.delete("never/existed");
        expect(await s.get("a/b")).toBeNull();
      }));

    it("lists by prefix, sorted, with size and modification time", () =>
      withStore(async (s) => {
        const before = Date.now() - 5000;
        await s.put("documents/u1/b", bytes("12345"));
        await s.put("documents/u1/a", bytes("1"));
        await s.put("documents/u2/a", bytes("12"));
        await s.put("pending/u1/x", bytes("z"));
        await s.put("documents-other/x", bytes("z"));

        expect(await keys(s, "documents/")).toEqual([
          "documents/u1/a",
          "documents/u1/b",
          "documents/u2/a",
        ]);
        expect(await keys(s, "documents/u1/")).toEqual([
          "documents/u1/a",
          "documents/u1/b",
        ]);
        expect(await keys(s, "documents/u1/a")).toEqual(["documents/u1/a"]);
        expect(await keys(s, "documents")).toEqual([
          "documents-other/x",
          "documents/u1/a",
          "documents/u1/b",
          "documents/u2/a",
        ]);
        expect(await keys(s, "documents/u3/")).toEqual([]);
        expect(await keys(s, "")).toHaveLength(5);

        const infos = [];
        for await (const i of s.list("documents/u1/")) infos.push(i);
        expect(infos.map((i) => i.size)).toEqual([1, 5]);
        for (const i of infos) {
          expect(i.modifiedAt).toBeGreaterThan(before);
          expect(i.modifiedAt).toBeLessThanOrEqual(Date.now() + 1000);
        }
      }));

    it("sorts by UTF-8 bytes, not UTF-16 code units", () =>
      withStore(async (s) => {
        // U+FFFD is one code unit above the surrogates of U+1F600 in UTF-16, below it in UTF-8.
        const bmp = "n/\uFFFD";
        const astral = "n/\u{1F600}";
        await s.put(astral, bytes("x"));
        await s.put(bmp, bytes("x"));
        await s.put("n/a", bytes("x"));
        expect(await keys(s, "n/")).toEqual(["n/a", bmp, astral]);
      }));

    it("does not list a deleted key", () =>
      withStore(async (s) => {
        await s.put("a/1", bytes("x"));
        await s.put("a/2", bytes("x"));
        await s.delete("a/1");
        expect(await keys(s, "a/")).toEqual(["a/2"]);
      }));

    it("rejects keys that could escape the store", () =>
      withStore(async (s) => {
        for (const bad of [
          "",
          "/abs",
          "../x",
          "a/../../x",
          "a/./b",
          "a//b",
          "a/",
          "a\\b",
          "a\0b",
        ]) {
          await expect(s.put(bad, bytes("x")), bad).rejects.toThrow(
            "Invalid storage key",
          );
          await expect(s.get(bad), bad).rejects.toThrow();
          await expect(s.has(bad), bad).rejects.toThrow();
          await expect(s.delete(bad), bad).rejects.toThrow();
        }
        await expect(keys(s, "../")).rejects.toThrow();
      }));
  });
}
