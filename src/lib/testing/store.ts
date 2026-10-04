import { afterEach, beforeEach } from "vitest";
import { clearExtractionCache } from "$lib/server/bills/extraction";
import { MemoryBlobStore, setStore } from "$lib/server/storage";

/** Call at the top level of a test file: every test gets an empty in-memory blob store. */
export function useTestStore(): { readonly store: MemoryBlobStore } {
  let current: MemoryBlobStore | null = null;
  beforeEach(() => {
    current = new MemoryBlobStore();
    setStore(current);
    clearExtractionCache();
  });
  afterEach(() => {
    setStore(null);
    current = null;
  });
  return {
    get store() {
      if (!current) throw new Error("useTestStore: no store outside a test");
      return current;
    },
  };
}
