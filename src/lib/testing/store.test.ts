import { describe, expect, it } from "vitest";
import { getStore } from "$lib/server/storage";
import { useTestStore } from "./store";

describe("useTestStore", () => {
  const blobs = useTestStore();

  it("installs an empty memory store as the process-wide store", async () => {
    expect(getStore()).toBe(blobs.store);
    expect(await Array.fromAsync(getStore().list(""))).toEqual([]);
    await getStore().put("a/b", new Uint8Array([1]));
  });

  it("starts every test with a fresh store", async () => {
    expect(await blobs.store.has("a/b")).toBe(false);
  });
});
