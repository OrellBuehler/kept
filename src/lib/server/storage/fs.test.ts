import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBlobStore } from "./fs";

describe("FsBlobStore", () => {
  let dir: string;
  let store: FsBlobStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kept-fs-"));
    store = new FsBlobStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("maps a key to the same relative path below the root", async () => {
    await store.put("documents/u1/id1", new TextEncoder().encode("x"));
    expect(statSync(join(dir, "documents", "u1", "id1")).isFile()).toBe(true);
  });

  it("creates files 0600 and directories 0700", async () => {
    await store.put("documents/u1/id1", new Uint8Array([1]));
    expect(statSync(join(dir, "documents/u1/id1")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "documents/u1")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "documents")).mode & 0o777).toBe(0o700);
  });

  it("leaves no temporary file behind and hides in-flight ones from list", async () => {
    await store.put("a/b", new Uint8Array([1]));
    expect(readdirSync(join(dir, "a"))).toEqual(["b"]);
    await writeFile(join(dir, "a", "b.kept-tmp-123"), "partial");
    const keys: string[] = [];
    for await (const i of store.list("a/")) keys.push(i.key);
    expect(keys).toEqual(["a/b"]);
  });

  it("cleans up the temporary file when the write fails", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await expect(store.put("a/b", new Uint8Array([1]))).rejects.toThrow();
    expect(readdirSync(join(dir, "a"))).toEqual(["b"]);
  });

  it("reports the file's modification time", async () => {
    await store.put("a/old", new Uint8Array([1]));
    const old = new Date("2020-01-02T03:04:05Z");
    utimesSync(join(dir, "a/old"), old, old);
    const [info] = await Array.fromAsync(store.list("a/"));
    expect(info).toMatchObject({
      key: "a/old",
      size: 1,
      modifiedAt: old.getTime(),
    });
  });

  it("cannot read or write through a path that leaves the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kept-outside-"));
    try {
      await writeFile(join(outside, "secret"), "s");
      const rel = join("..", resolve(outside).split("/").pop()!, "secret");
      await expect(store.get(rel)).rejects.toThrow();
      await expect(store.put(rel, new Uint8Array([1]))).rejects.toThrow();
      await expect(store.delete(rel)).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("treats a directory as not a blob and does not delete it", async () => {
    await store.put("a/b/c", new Uint8Array([1]));
    expect(await store.has("a/b")).toBe(false);
    await expect(store.delete("a/b")).rejects.toThrow();
    expect(await store.has("a/b/c")).toBe(true);
  });

  it("lists nothing for a root that does not exist yet", async () => {
    const fresh = new FsBlobStore(join(dir, "not-created"));
    expect(await Array.fromAsync(fresh.list(""))).toEqual([]);
    expect(await fresh.get("a")).toBeNull();
  });

  it("treats a directory at the key as missing for get", async () => {
    await store.put("a/b/c", new Uint8Array([1]));
    expect(await store.get("a/b")).toBeNull();
  });

  it("works with a root of /", async () => {
    const rootStore = new FsBlobStore("/");
    expect(await rootStore.has("kept-nonexistent-test-key")).toBe(false);
    await expect(rootStore.get("../x")).rejects.toThrow();
  });

  describe("sweepStaleTemp", () => {
    const hourAgo = (ms: number) => new Date(Date.now() - ms);
    it("removes only temporary files older than an hour, anywhere under the root", async () => {
      await store.put("a/keep", new Uint8Array([1]));
      await mkdir(join(dir, "a", "deep"), { recursive: true });
      const stale = [
        join(dir, "a", "keep.kept-tmp-1"),
        join(dir, "a", "deep", "x.kept-tmp-2"),
      ];
      const fresh = join(dir, "a", "fresh.kept-tmp-3");
      const old = join(dir, "a", "old-but-not-tmp");
      for (const f of [...stale, fresh, old]) await writeFile(f, "x");
      for (const f of [...stale, old]) {
        utimesSync(f, hourAgo(2 * 3600_000), hourAgo(2 * 3600_000));
      }
      expect(await store.sweepStaleTemp()).toBe(2);
      expect(readdirSync(join(dir, "a")).sort()).toEqual([
        "deep",
        "fresh.kept-tmp-3",
        "keep",
        "old-but-not-tmp",
      ]);
    });

    it("is a no-op for a root that does not exist", async () => {
      expect(await new FsBlobStore(join(dir, "nope")).sweepStaleTemp()).toBe(0);
    });
  });
});
