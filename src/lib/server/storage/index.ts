import type { BlobStore } from "./blob-store";
import { createFsBlobStore, FsBlobStore } from "./fs";
import { S3BlobStore } from "./s3";
import { readStorageConfig, type StorageConfig } from "./config";

export * from "./config";
export * from "./blob-store";
export { FsBlobStore } from "./fs";
export { MemoryBlobStore } from "./memory";
export { S3BlobStore } from "./s3";

export function createStore(config: StorageConfig): BlobStore {
  return config.kind === "s3"
    ? new S3BlobStore(config)
    : createFsBlobStore(config.dir);
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

/** Startup housekeeping for the local-files store: removes leftovers of crashed writes. */
export async function sweepStaleStorageTemp(): Promise<number> {
  const current = getStore();
  return current instanceof FsBlobStore ? current.sweepStaleTemp() : 0;
}
