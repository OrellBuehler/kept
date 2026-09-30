import type { PendingMeta } from "./pending";

const MAX_ENTRIES = 4;
const store = new Map<string, unknown>();

/**
 * Tiny LRU for parsed pending files (camt statements, raw csv/xlsx rows), so
 * paging through a preview or typing in the mapping form does not re-parse a
 * large file each time. Keys carry user id, pending id and content hash;
 * only successful results are stored.
 */
export function cachedParse<T>(
  meta: PendingMeta,
  variant: string,
  compute: () => T,
): T {
  const key = `${meta.userId}:${meta.id}:${meta.sha256}:${variant}`;
  if (store.has(key)) {
    const hit = store.get(key) as T;
    store.delete(key);
    store.set(key, hit);
    return hit;
  }
  const value = compute();
  store.set(key, value);
  while (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value as string);
  }
  return value;
}

export function clearParseCache(): void {
  store.clear();
}

export function parseCacheSize(): number {
  return store.size;
}
