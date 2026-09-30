import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  PaperlessClient,
  PaperlessError,
  classifyFetchError,
  messageForCode,
  normalizeBaseUrl,
} from "./client";
import { startFakePaperless } from "./fake-server";

const fake = startFakePaperless();
afterAll(() => fake.stop());

beforeEach(() => {
  fake.requests = [];
  fake.token = "test-token";
  fake.accepted = [9, 10];
  fake.redirectAll = false;
  fake.delayMs = 0;
  fake.wrongHostNext = false;
  fake.pageSize = null;
  fake.prefix = "";
  fake.docs.clear();
  fake.customFieldsStatus = 200;
});

const client = (
  over: Partial<ConstructorParameters<typeof PaperlessClient>[0]> = {},
) =>
  new PaperlessClient({ baseUrl: fake.baseUrl, token: "test-token", ...over });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PaperlessError) return err.code;
    throw err;
  }
  return "none";
}

const idList = z.object({ id: z.number() });

describe("normalizeBaseUrl", () => {
  it("keeps origin and path prefix, drops trailing slashes, query and fragment", () => {
    expect(normalizeBaseUrl(" https://paperless.example/ ")).toBe(
      "https://paperless.example",
    );
    expect(normalizeBaseUrl("http://10.0.0.5:8000/paperless//")).toBe(
      "http://10.0.0.5:8000/paperless",
    );
    expect(normalizeBaseUrl("https://p.example/sub?x=1#y")).toBe(
      "https://p.example/sub",
    );
  });

  it("rejects other schemes, credentials and garbage", () => {
    for (const bad of [
      "ftp://p.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@p.example",
      "https://user@p.example",
      "not a url",
      "",
    ]) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(PaperlessError);
    }
  });
});

describe("PaperlessClient requests", () => {
  it("sends the token and asks for API version 9 first", async () => {
    await client().json("documents", z.object({ results: z.array(idList) }));
    const req = fake.requests[0]!;
    expect(req.headers.get("authorization")).toBe("Token test-token");
    expect(req.headers.get("accept")).toBe("application/json; version=9");
  });

  it("retries once with version 10 after a 406 and remembers it", async () => {
    fake.accepted = [10];
    const c = client();
    await c.json("documents", z.object({ results: z.array(idList) }));
    expect(fake.requests.map((r) => r.headers.get("accept"))).toEqual([
      "application/json; version=9",
      "application/json; version=10",
    ]);
    expect(c.apiVersion).toBe(10);
    fake.requests = [];
    await c.json("documents", z.object({ results: z.array(idList) }));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers.get("accept")).toBe(
      "application/json; version=10",
    );
  });

  it("falls back from 10 to 9 as well, and reports version when neither works", async () => {
    fake.accepted = [9];
    const c = client({ apiVersion: 10 });
    await c.json("documents", z.object({ results: z.array(idList) }));
    expect(c.apiVersion).toBe(9);
    fake.accepted = [];
    expect(
      await codeOf(c.json("documents", z.object({ results: z.array(idList) }))),
    ).toBe("version");
  });

  it("always requests URLs with a trailing slash", async () => {
    const c = client();
    expect(c.url("documents")).toBe(`${fake.baseUrl}/api/documents/`);
    expect(c.url("/documents/5/download/", { original: "true" })).toBe(
      `${fake.baseUrl}/api/documents/5/download/?original=true`,
    );
    await c.json("documents", z.object({ results: z.array(idList) }));
    expect(fake.requests.every((r) => r.path.endsWith("/"))).toBe(true);
  });

  it("supports a path prefix", async () => {
    fake.prefix = "/paperless";
    const c = client();
    await c.json("documents", z.object({ results: z.array(idList) }));
    expect(fake.requests[0]!.path).toBe("/paperless/api/documents/");
  });

  it("reads the server version headers", async () => {
    const c = client();
    await c.json("documents", z.object({ results: z.array(idList) }));
    expect(c.serverInfo).toEqual({
      serverVersion: "2.20.3",
      maxApiVersion: 10,
    });
  });

  it("refuses redirects instead of following them", async () => {
    fake.redirectAll = true;
    const code = await codeOf(
      client().json("documents", z.object({ results: z.array(idList) })),
    );
    expect(code).toBe("redirect");
    expect(fake.requests).toHaveLength(1);
  });

  it("times out slow servers", async () => {
    fake.delayMs = 400;
    const code = await codeOf(
      client({ timeoutMs: 50 }).json(
        "documents",
        z.object({ results: z.array(idList) }),
      ),
    );
    expect(code).toBe("network");
  });

  it("maps 401, 403 and 404 and never leaks the token into messages", async () => {
    fake.token = "other";
    const unauthorized = client().json("documents", z.unknown());
    await expect(unauthorized).rejects.toMatchObject({ code: "unauthorized" });
    await unauthorized.catch((e: Error) => {
      expect(e.message).not.toContain("test-token");
    });
    fake.token = "test-token";
    fake.customFieldsStatus = 403;
    expect(await codeOf(client().json("custom_fields", z.unknown()))).toBe(
      "forbidden",
    );
    expect(await codeOf(client().json("documents/999", z.unknown()))).toBe(
      "not_found",
    );
  });

  it("maps an unreachable server to network", async () => {
    expect(
      await codeOf(
        new PaperlessClient({
          baseUrl: "http://127.0.0.1:1",
          token: "x",
          timeoutMs: 500,
        }).json("documents", z.unknown()),
      ),
    ).toBe("network");
  });

  it("rejects unexpected response shapes without echoing them", async () => {
    const err = await client()
      .json("documents", z.object({ nothing: z.string() }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaperlessError);
    expect((err as PaperlessError).code).toBe("invalid_response");
  });
});

describe("PaperlessClient pagination", () => {
  it("walks all pages and never contacts the host named in `next`", async () => {
    for (let i = 1; i <= 5; i++) fake.addDoc({ id: i });
    fake.pageSize = 2;
    fake.wrongHostNext = true;
    const ids: number[] = [];
    for await (const page of client().pages(
      "documents",
      { page_size: 2 },
      idList,
    )) {
      ids.push(...page.map((d) => d.id));
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(fake.requests).toHaveLength(3);
  });

  it("fails on a next link that does not advance", async () => {
    for (let i = 1; i <= 3; i++) fake.addDoc({ id: i });
    fake.pageSize = 1;
    const c = client();
    const original = c.json.bind(c);
    c.json = (async (path: string, schema: z.ZodType, options: unknown) => {
      const page = (await original(path, schema, options as never)) as {
        next?: string | null;
      };
      page.next = `${fake.origin}/api/documents/?page_size=1`;
      return page;
    }) as never;
    const pages = async () => {
      for await (const page of c.pages("documents", { page_size: 1 }, idList)) {
        void page;
      }
    };
    expect(await codeOf(pages())).toBe("invalid_response");
  });
});

describe("PaperlessClient downloads", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\nsynthetic\n%%EOF");

  it("downloads a PDF and asks for the original when told to", async () => {
    fake.addDoc({ id: 1, original: pdf });
    const bytes = await client().download("documents/1/download", {
      original: "true",
    });
    expect(Array.from(bytes)).toEqual(Array.from(pdf));
    expect(fake.requests[0]!.query.get("original")).toBe("true");
  });

  it("rejects a wrong content type", async () => {
    fake.addDoc({ id: 1, original: pdf, contentType: "text/html" });
    expect(
      await codeOf(
        client().download("documents/1/download", { original: "true" }),
      ),
    ).toBe("wrong_type");
  });

  it("enforces the size cap from content-length", async () => {
    fake.addDoc({ id: 1, original: pdf });
    expect(
      await codeOf(
        client({ maxDownloadBytes: 10 }).download("documents/1/download", {
          original: "true",
        }),
      ),
    ).toBe("too_large");
  });

  it("enforces the size cap on streams without content-length", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 5; i++)
                controller.enqueue(new Uint8Array(100));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/pdf" } },
        ),
    });
    try {
      const c = new PaperlessClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: "x",
        maxDownloadBytes: 250,
      });
      expect(await codeOf(c.download("documents/1/download"))).toBe(
        "too_large",
      );
    } finally {
      await server.stop(true);
    }
  });

  it("maps a missing document to not_found", async () => {
    expect(await codeOf(client().download("documents/42/download"))).toBe(
      "not_found",
    );
  });
});

describe("error classification", () => {
  it("recognises certificate problems", () => {
    const err = Object.assign(
      new Error("unable to verify the first certificate"),
      {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      },
    );
    expect(classifyFetchError(err).code).toBe("tls");
    expect(classifyFetchError(new Error("self signed certificate")).code).toBe(
      "tls",
    );
    expect(classifyFetchError(new Error("connect ECONNREFUSED")).code).toBe(
      "network",
    );
  });

  it("has a message for every stored code", () => {
    expect(messageForCode("tls")).toMatch(/certificate/);
    expect(messageForCode("push_forbidden")).toMatch(/permission/);
    expect(messageForCode("no_source")).toMatch(/Choose/);
    expect(messageForCode("whatever")).toBe("An unexpected error occurred.");
  });
});

describe("response limits and TLS options", () => {
  it("caps JSON bodies", async () => {
    fake.addDoc({ id: 1 });
    expect(
      await codeOf(client({ maxJsonBytes: 20 }).json("documents", z.unknown())),
    ).toBe("too_large");
  });

  it("never disables certificate verification unless the connection allows it", async () => {
    const seen: Array<unknown> = [];
    const real = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        seen.push((init as { tls?: unknown } | undefined)?.tls);
        return real(input, init);
      });
    try {
      await client().json("documents", z.unknown());
      await client({ allowInsecureTls: false }).json("documents", z.unknown());
      expect(seen).toEqual([undefined, undefined]);
      await client({ allowInsecureTls: true }).json("documents", z.unknown());
      expect(seen[2]).toEqual({ rejectUnauthorized: false });
    } finally {
      spy.mockRestore();
    }
  });
});
