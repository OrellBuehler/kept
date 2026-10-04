import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FsBlobStore,
  MemoryBlobStore,
  getStore,
  setStore,
  sweepStaleStorageTemp,
} from "./index";

describe("getStore", () => {
  afterEach(() => setStore(null));

  it("returns the store that was set until it is reset", () => {
    const memory = new MemoryBlobStore();
    setStore(memory);
    expect(getStore()).toBe(memory);
  });

  it("builds a local store from the environment by default", () => {
    setStore(null);
    expect(getStore()).toBeInstanceOf(FsBlobStore);
    expect(getStore()).toBe(getStore());
  });
});

describe("sweepStaleStorageTemp", () => {
  afterEach(() => setStore(null));

  it("sweeps the fs store and ignores other stores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kept-sweep-"));
    try {
      const file = join(dir, "x.kept-tmp-1");
      writeFileSync(file, "x");
      const old = new Date(Date.now() - 2 * 3600_000);
      utimesSync(file, old, old);
      setStore(new FsBlobStore(dir));
      expect(await sweepStaleStorageTemp()).toBe(1);
      setStore(new MemoryBlobStore());
      expect(await sweepStaleStorageTemp()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
