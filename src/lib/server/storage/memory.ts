import {
  assertKey,
  assertPrefix,
  compareKeys,
  type BlobInfo,
  type BlobStore,
} from "./blob-store";

interface Entry {
  bytes: Uint8Array;
  modifiedAt: number;
}

/** In-process store for tests. Copies on the way in and out, so callers cannot alias its bytes. */
export class MemoryBlobStore implements BlobStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key);
    this.entries.set(key, { bytes: bytes.slice(), modifiedAt: this.now() });
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    return this.entries.get(key)?.bytes.slice() ?? null;
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    return this.entries.has(key);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    this.entries.delete(key);
  }

  async *list(prefix: string): AsyncIterable<BlobInfo> {
    assertPrefix(prefix);
    const keys = [...this.entries.keys()].filter((k) => k.startsWith(prefix));
    for (const key of keys.sort(compareKeys)) {
      const e = this.entries.get(key);
      if (e) yield { key, size: e.bytes.byteLength, modifiedAt: e.modifiedAt };
    }
  }
}
