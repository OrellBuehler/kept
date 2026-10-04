import type { BlobStore } from "./blob-store";
import { createFsBlobStore } from "./fs";
import { readStorageConfig, type StorageConfig } from "./config";

export * from "./config";
export * from "./blob-store";
export { FsBlobStore } from "./fs";
export { MemoryBlobStore } from "./memory";

export function createStore(config: StorageConfig): BlobStore {
  return createFsBlobStore(config.dir);
}

let store: BlobStore | null = null;

/** The process-wide store, built from the environment on first use. */
export function getStore(): BlobStore {
  if (!store) store = createStore(readStorageConfig());
  return store;
}

/** Replace the process-wide store. Tests only; pass null to reset. */
export function setStore(next: BlobStore | null): void {
  store = next;
}
