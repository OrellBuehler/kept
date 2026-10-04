import { afterEach, describe, expect, it } from "vitest";
import { FsBlobStore, MemoryBlobStore, getStore, setStore } from "./index";

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
