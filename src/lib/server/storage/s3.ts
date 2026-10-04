import { describeError } from "$lib/server/errors";
import {
  assertKey,
  assertPrefix,
  type BlobInfo,
  type BlobStore,
} from "./blob-store";
import type { S3StorageConfig } from "./config";

const MAX_PAGE_SIZE = 1000;
/** Bun's S3 client never gives up on an unreachable endpoint, so every call is bounded here. */
export const S3_TIMEOUT_MS = 60_000;

type ListedObject = { key: string; size?: number; lastModified?: unknown };

function s3Code(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(err: unknown): boolean {
  const code = s3Code(err);
  return code === "NoSuchKey" || code === "NotFound";
}

/**
 * The endpoint Bun needs. In virtual-hosted style Bun uses the endpoint host as given, so
 * the bucket is put in front of it unless the host already starts with it. Path-style
 * endpoints and the inferred AWS endpoint are passed through.
 */
export function s3ClientEndpoint(
  config: Pick<S3StorageConfig, "endpoint" | "bucket" | "virtualHostedStyle">,
): string | undefined {
  if (!config.endpoint || !config.virtualHostedStyle) return config.endpoint;
  const url = new URL(config.endpoint);
  if (!url.hostname.startsWith(`${config.bucket}.`)) {
    url.hostname = `${config.bucket}.${url.hostname}`;
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Blobs as objects in an S3-compatible bucket, through `Bun.S3Client` (no extra dependency).
 *
 * Every key is stored under `config.prefix`. Errors carry the operation and the S3 error
 * code only (see `describeError`); configuration, keys and credentials are never included.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: Bun.S3Client;
  private readonly keyPrefix: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(
    config: S3StorageConfig,
    options: {
      timeoutMs?: number;
      pageSize?: number;
      client?: Bun.S3Client;
    } = {},
  ) {
    this.keyPrefix = config.prefix === "" ? "" : `${config.prefix}/`;
    this.timeoutMs = options.timeoutMs ?? S3_TIMEOUT_MS;
    this.pageSize = Math.min(options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    this.client =
      options.client ??
      new Bun.S3Client({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        bucket: config.bucket,
        region: config.region,
        endpoint: s3ClientEndpoint(config),
        virtualHostedStyle: config.virtualHostedStyle,
      });
  }

  private async run<T>(op: string, work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`S3 ${op} timed out`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(op: string, err: unknown): Error {
    if (err instanceof Error && err.message === `S3 ${op} timed out`) {
      return err;
    }
    return new Error(`S3 ${op} failed (${describeError(err)})`);
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<void> {
    assertKey(key);
    try {
      await this.run("put", () =>
        this.client.file(this.keyPrefix + key).write(bytes, {
          type: contentType ?? "application/octet-stream",
        }),
      );
    } catch (err) {
      throw this.fail("put", err);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    try {
      const buffer = await this.run("get", () =>
        this.client.file(this.keyPrefix + key).arrayBuffer(),
      );
      return new Uint8Array(buffer);
    } catch (err) {
      if (isMissing(err)) return null;
      throw this.fail("get", err);
    }
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    try {
      return await this.run("has", () =>
        this.client.file(this.keyPrefix + key).exists(),
      );
    } catch (err) {
      throw this.fail("has", err);
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    try {
      await this.run("delete", () =>
        this.client.file(this.keyPrefix + key).delete(),
      );
    } catch (err) {
      // Deleting what is already gone is the contract, not a failure.
      if (isMissing(err)) return;
      throw this.fail("delete", err);
    }
  }

  async *list(prefix: string): AsyncIterable<BlobInfo> {
    assertPrefix(prefix);
    const found: BlobInfo[] = [];
    const fullPrefix = this.keyPrefix + prefix;
    let startAfter: string | undefined;
    try {
      for (;;) {
        const page = await this.run("list", () =>
          this.client.list({
            prefix: fullPrefix,
            maxKeys: this.pageSize,
            startAfter,
          }),
        );
        const contents = (page.contents ?? []) as ListedObject[];
        for (const object of contents) {
          // Console-created folder markers end in a slash and are not blobs.
          if (object.key.endsWith("/")) continue;
          const modifiedAt = Date.parse(String(object.lastModified));
          if (Number.isNaN(modifiedAt)) {
            throw new Error("S3 list returned an object without a date");
          }
          found.push({
            key: object.key.slice(this.keyPrefix.length),
            size: object.size ?? 0,
            modifiedAt,
          });
        }
        const last = contents.at(-1)?.key;
        if (!page.isTruncated) break;
        if (last === undefined || last === startAfter) {
          throw new Error("S3 list pagination did not advance");
        }
        startAfter = last;
      }
    } catch (err) {
      throw this.fail("list", err);
    }
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    yield* found;
  }
}
