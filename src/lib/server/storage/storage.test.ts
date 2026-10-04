import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobStoreContract } from "./contract";
import { FsBlobStore } from "./fs";
import { MemoryBlobStore } from "./memory";

blobStoreContract("fs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kept-blobs-"));
  return {
    store: new FsBlobStore(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

blobStoreContract("memory", async () => ({ store: new MemoryBlobStore() }));
