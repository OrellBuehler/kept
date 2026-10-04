import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  assertKey,
  assertPrefix,
  type BlobInfo,
  type BlobStore,
} from "./blob-store";

const TMP_MARKER = ".kept-tmp-";

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Blobs as files below one root directory; key `a/b` is the file `<root>/a/b`. */
export class FsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) {
      throw new Error("Storage key escapes the storage directory");
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}${TMP_MARKER}${randomUUID()}`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile();
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async *list(prefix: string): AsyncIterable<BlobInfo> {
    assertPrefix(prefix);
    const slash = prefix.lastIndexOf("/");
    const dirKey = slash === -1 ? "" : prefix.slice(0, slash);
    const start = dirKey === "" ? this.root : this.path(dirKey);
    const found: BlobInfo[] = [];
    await this.walk(start, dirKey === "" ? "" : `${dirKey}/`, prefix, found);
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    yield* found;
  }

  private async walk(
    dir: string,
    keyPrefix: string,
    filter: string,
    out: BlobInfo[],
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const key = keyPrefix + entry.name;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        // Only descend into directories that can still contain a match.
        const dirKey = `${key}/`;
        if (dirKey.startsWith(filter) || filter.startsWith(dirKey)) {
          await this.walk(full, dirKey, filter, out);
        }
      } else if (
        entry.isFile() &&
        key.startsWith(filter) &&
        !entry.name.includes(TMP_MARKER)
      ) {
        try {
          const info = await stat(full);
          out.push({
            key,
            size: info.size,
            modifiedAt: Math.floor(info.mtimeMs),
          });
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
    }
  }
}

export function createFsBlobStore(dir: string): BlobStore {
  return new FsBlobStore(dir);
}
