export interface BlobInfo {
  key: string;
  size: number;
  /** Epoch milliseconds of the last write. */
  modifiedAt: number;
}

/**
 * Where user files live. Keys are `/`-separated relative paths such as
 * `documents/<userId>/<id>`. Every store enforces the same key rules (see `assertKey`).
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  /** The stored bytes, or null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  /** Removing a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
  /** Every blob whose key starts with `prefix`, sorted by the UTF-8 bytes of the key (`compareKeys`). */
  list(prefix: string): AsyncIterable<BlobInfo>;
}

/** Orders keys by their UTF-8 bytes, as S3 lists them (not by UTF-16 code units). */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Rejects keys that could leave the store: absolute, empty or dot segments, backslashes, NUL. */
export function assertKey(key: string): void {
  if (
    key === "" ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error("Invalid storage key");
  }
}

/** Like `assertKey` for list prefixes, which may end in a partial segment or a `/`. */
export function assertPrefix(prefix: string): void {
  if (prefix === "") return;
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  assertKey(trimmed);
}
