import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blobStoreContract } from "./contract";
import type { S3StorageConfig } from "./config";
import { S3BlobStore, s3ClientEndpoint } from "./s3";

const env = process.env;
const live =
  env.KEPT_TEST_S3_ENDPOINT &&
  env.KEPT_TEST_S3_BUCKET &&
  env.KEPT_TEST_S3_ACCESS_KEY_ID &&
  env.KEPT_TEST_S3_SECRET_ACCESS_KEY
    ? {
        endpoint: env.KEPT_TEST_S3_ENDPOINT,
        bucket: env.KEPT_TEST_S3_BUCKET,
        accessKeyId: env.KEPT_TEST_S3_ACCESS_KEY_ID,
        secretAccessKey: env.KEPT_TEST_S3_SECRET_ACCESS_KEY,
      }
    : null;

function liveConfig(prefix: string): S3StorageConfig {
  if (!live) throw new Error("KEPT_TEST_S3_* is not set");
  return {
    kind: "s3",
    ...live,
    region: env.KEPT_TEST_S3_REGION || "us-east-1",
    prefix,
    virtualHostedStyle: false,
  };
}

async function wipe(store: S3BlobStore): Promise<void> {
  for await (const info of store.list("")) await store.delete(info.key);
}

// Every contract case gets its own prefix, so runs and cases never collide.
const runId = randomUUID();

if (live) {
  blobStoreContract("s3", async () => {
    const store = new S3BlobStore(
      liveConfig(`kept-test/${runId}/${randomUUID()}`),
    );
    return { store, cleanup: () => wipe(store) };
  });

  describe("S3BlobStore against a live service", () => {
    const prefix = `kept-test/${runId}/live`;

    it("keeps stores with different prefixes apart", async () => {
      const a = new S3BlobStore(liveConfig(`${prefix}/a`));
      const b = new S3BlobStore(liveConfig(`${prefix}/b`));
      const abc = new S3BlobStore(liveConfig(`${prefix}/ab`));
      try {
        await a.put("documents/u1/x", new Uint8Array([1]));
        await abc.put("documents/u1/y", new Uint8Array([2]));
        expect(await b.has("documents/u1/x")).toBe(false);
        const listed: string[] = [];
        for await (const i of a.list("")) listed.push(i.key);
        expect(listed).toEqual(["documents/u1/x"]);
      } finally {
        await wipe(a);
        await wipe(b);
        await wipe(abc);
      }
    });

    it("lists more objects than fit in one page, in order", async () => {
      const store = new S3BlobStore(liveConfig(`${prefix}/pages`), {
        pageSize: 3,
      });
      try {
        const names = Array.from({ length: 8 }, (_, i) => `n/${i}`);
        for (const n of [...names].reverse()) {
          await store.put(n, new Uint8Array([1]));
        }
        const listed: string[] = [];
        for await (const i of store.list("n/")) listed.push(i.key);
        expect(listed).toEqual(names);
      } finally {
        await wipe(store);
      }
    });

    it("stores the content type", async () => {
      const store = new S3BlobStore(liveConfig(`${prefix}/type`));
      try {
        await store.put("a.pdf", new Uint8Array([1]), "application/pdf");
        const client = new Bun.S3Client({
          accessKeyId: live.accessKeyId,
          secretAccessKey: live.secretAccessKey,
          bucket: live.bucket,
          endpoint: live.endpoint,
          region: env.KEPT_TEST_S3_REGION || "us-east-1",
        });
        const stat = await client.stat(`${prefix}/type/a.pdf`);
        expect(stat.type).toContain("application/pdf");
      } finally {
        await wipe(store);
      }
    });

    it("handles keys with special characters", async () => {
      const store = new S3BlobStore(liveConfig(`${prefix}/chars`));
      try {
        const key = "documents/u 1/a b+c%d#e?f&g=h.pdf";
        await store.put(key, new Uint8Array([7]));
        expect(await store.get(key)).toEqual(new Uint8Array([7]));
        const listed: string[] = [];
        for await (const i of store.list("documents/")) listed.push(i.key);
        expect(listed).toEqual([key]);
      } finally {
        await wipe(store);
      }
    });

    it("reports a wrong secret without leaking it", async () => {
      const store = new S3BlobStore({
        ...liveConfig(`${prefix}/auth`),
        secretAccessKey: "wrong-secret-value-0123",
      });
      const err = await store.get("k").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const text = JSON.stringify(err) + (err as Error).message;
      expect(text).not.toContain("wrong-secret-value-0123");
      expect(text).not.toContain(live.secretAccessKey);
      expect((err as Error).message).toMatch(/^S3 get failed \(/);
    });
  });
} else {
  describe("S3BlobStore against a live service", () => {
    it.skip("needs KEPT_TEST_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY", () => {});
  });
}

const baseConfig: S3StorageConfig = {
  kind: "s3",
  bucket: "bkt",
  endpoint: "http://s3.invalid:9000",
  region: "us-east-1",
  accessKeyId: "AKIDEXAMPLE0000",
  secretAccessKey: "SECRETEXAMPLE0000",
  prefix: "pre/fix",
  virtualHostedStyle: false,
};

class S3Error extends Error {
  constructor(
    readonly code: string,
    message = "boom",
  ) {
    super(message);
    this.name = "S3Error";
  }
}

type FakeObject = { key: string; size?: number; lastModified?: unknown };

function fakeClient(handlers: {
  file?: (key: string) => Record<string, (...args: never[]) => unknown>;
  list?: (opts: {
    prefix?: string;
    maxKeys?: number;
    startAfter?: string;
  }) => Promise<{ contents?: FakeObject[]; isTruncated?: boolean }>;
}): Bun.S3Client {
  return {
    file: (key: string) => handlers.file?.(key) ?? {},
    list: (opts: object) => handlers.list?.(opts) ?? Promise.resolve({}),
  } as unknown as Bun.S3Client;
}

describe("S3BlobStore (fake client)", () => {
  it("prefixes keys and strips the prefix from listings", async () => {
    const seen: string[] = [];
    const listed: object[] = [];
    const store = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: (key) => ({
          exists: async () => (seen.push(key), true),
        }),
        list: async (opts) => {
          listed.push(opts);
          return {
            contents: [
              {
                key: "pre/fix/b",
                size: 2,
                lastModified: "2026-01-02T00:00:00Z",
              },
              {
                key: "pre/fix/a",
                size: 1,
                lastModified: "2026-01-01T00:00:00Z",
              },
              {
                key: "pre/fix/folder/",
                size: 0,
                lastModified: "2026-01-01T00:00:00Z",
              },
            ],
          };
        },
      }),
    });
    await store.has("documents/u/1");
    expect(seen).toEqual(["pre/fix/documents/u/1"]);
    const out = [];
    for await (const i of store.list("documents/")) out.push(i);
    expect(listed).toEqual([
      { prefix: "pre/fix/documents/", maxKeys: 1000, startAfter: undefined },
    ]);
    expect(out).toEqual([
      { key: "a", size: 1, modifiedAt: Date.parse("2026-01-01T00:00:00Z") },
      { key: "b", size: 2, modifiedAt: Date.parse("2026-01-02T00:00:00Z") },
    ]);
  });

  it("lists the whole store when the prefix is empty, without a configured prefix", async () => {
    const prefixes: (string | undefined)[] = [];
    const store = new S3BlobStore(
      { ...baseConfig, prefix: "" },
      {
        client: fakeClient({
          list: async (opts) => (prefixes.push(opts.prefix), {}),
        }),
      },
    );
    for await (const i of store.list("")) void i;
    expect(prefixes).toEqual([""]);
  });

  it("follows pagination until the listing is complete", async () => {
    const calls: (string | undefined)[] = [];
    const store = new S3BlobStore(
      { ...baseConfig, prefix: "" },
      {
        pageSize: 2,
        client: fakeClient({
          list: async ({ startAfter }) => {
            calls.push(startAfter);
            const date = "2026-01-01T00:00:00Z";
            if (startAfter === undefined) {
              return {
                isTruncated: true,
                contents: [
                  { key: "a", size: 1, lastModified: date },
                  { key: "b", size: 1, lastModified: date },
                ],
              };
            }
            return {
              isTruncated: false,
              contents: [{ key: "c", size: 1, lastModified: date }],
            };
          },
        }),
      },
    );
    const keys: string[] = [];
    for await (const i of store.list("")) keys.push(i.key);
    expect(keys).toEqual(["a", "b", "c"]);
    expect(calls).toEqual([undefined, "b"]);
  });

  it("fails instead of looping when pagination does not advance", async () => {
    const store = new S3BlobStore(baseConfig, {
      client: fakeClient({
        list: async () => ({ isTruncated: true, contents: [] }),
      }),
    });
    await expect(store.list("")[Symbol.asyncIterator]().next()).rejects.toThrow(
      "S3 list failed",
    );
  });

  it("returns null for a missing key and rethrows other errors", async () => {
    const missing = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => ({
          arrayBuffer: async () => {
            throw new S3Error("NoSuchKey");
          },
        }),
      }),
    });
    expect(await missing.get("k")).toBeNull();

    const denied = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => ({
          arrayBuffer: async () => {
            throw new S3Error("AccessDenied");
          },
        }),
      }),
    });
    await expect(denied.get("k")).rejects.toThrow(
      "S3 get failed (S3Error [AccessDenied])",
    );
  });

  it("treats deleting a missing key as success but not other failures", async () => {
    const gone = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => ({
          delete: async () => {
            throw new S3Error("NoSuchKey");
          },
        }),
      }),
    });
    await expect(gone.delete("k")).resolves.toBeUndefined();

    const denied = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => ({
          delete: async () => {
            throw new S3Error("AccessDenied");
          },
        }),
      }),
    });
    await expect(denied.delete("k")).rejects.toThrow("S3 delete failed");
  });

  it("sends the content type, defaulting to octet-stream", async () => {
    const types: unknown[] = [];
    const store = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => ({
          write: async (_bytes: unknown, opts?: unknown) => {
            types.push((opts as { type: string }).type);
            return 1;
          },
        }),
      }),
    });
    await store.put("a", new Uint8Array(), "application/pdf");
    await store.put("b", new Uint8Array());
    expect(types).toEqual(["application/pdf", "application/octet-stream"]);
  });

  it("never puts keys, messages, credentials or the endpoint in errors", async () => {
    const store = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => ({
          write: async () => {
            throw new S3Error(
              "SignatureDoesNotMatch",
              `bad signature for ${baseConfig.secretAccessKey} ${baseConfig.accessKeyId}`,
            );
          },
        }),
      }),
    });
    const err = (await store
      .put("documents/u1/secret-name", new Uint8Array())
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("S3 put failed (S3Error [SignatureDoesNotMatch])");
    expect(err.cause).toBeUndefined();
    for (const needle of [
      baseConfig.secretAccessKey,
      baseConfig.accessKeyId,
      "secret-name",
      "s3.invalid",
      "bkt",
    ]) {
      expect(err.message).not.toContain(needle);
    }
  });

  it("gives up on a request that never answers", async () => {
    const store = new S3BlobStore(baseConfig, {
      timeoutMs: 20,
      client: fakeClient({
        file: () => ({ exists: () => new Promise<boolean>(() => {}) }),
      }),
    });
    await expect(store.has("k")).rejects.toThrow("S3 has timed out");
  });

  it("applies the shared key rules before any request", async () => {
    const store = new S3BlobStore(baseConfig, {
      client: fakeClient({
        file: () => {
          throw new Error("must not be called");
        },
      }),
    });
    await expect(store.put("../x", new Uint8Array())).rejects.toThrow(
      "Invalid storage key",
    );
    await expect(store.get("a//b")).rejects.toThrow("Invalid storage key");
    await expect(store.delete("/abs")).rejects.toThrow("Invalid storage key");
    await expect(store.has("")).rejects.toThrow("Invalid storage key");
    await expect(
      store.list("../")[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("Invalid storage key");
  });
});

describe("s3ClientEndpoint", () => {
  const base = { bucket: "bkt", endpoint: "http://host:9000" };
  it("passes path-style and absent endpoints through", () => {
    expect(s3ClientEndpoint({ ...base, virtualHostedStyle: false })).toBe(
      "http://host:9000",
    );
    expect(
      s3ClientEndpoint({ bucket: "bkt", virtualHostedStyle: true }),
    ).toBeUndefined();
  });

  it("puts the bucket in the host for virtual-hosted style, once", () => {
    expect(s3ClientEndpoint({ ...base, virtualHostedStyle: true })).toBe(
      "http://bkt.host:9000",
    );
    expect(
      s3ClientEndpoint({
        bucket: "bkt",
        endpoint: "https://bkt.s3.eu-west-1.amazonaws.com",
        virtualHostedStyle: true,
      }),
    ).toBe("https://bkt.s3.eu-west-1.amazonaws.com");
  });
});
