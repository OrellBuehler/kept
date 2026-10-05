import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedFetch, requestPinned } from "./pinned-fetch";
import { PrivateNetworkError, type Lookup } from "./private-network";

const servers: Array<{ stop(force?: boolean): void }> = [];
const serve = (fetch: (req: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  servers.push(server);
  return server;
};
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Answers with a public address first and a loopback one afterwards, like a rebinding DNS server. */
function rebindingLookup() {
  const calls: string[] = [];
  const lookup: Lookup = async (host) => {
    calls.push(host);
    return calls.length === 1
      ? [{ address: "203.0.113.7", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  return { lookup, calls };
}

describe("pinnedFetch", () => {
  it("resolves once and never connects to a later, different answer (DNS rebinding)", async () => {
    let hits = 0;
    const server = serve(() => {
      hits++;
      return new Response("internal");
    });
    const { lookup, calls } = rebindingLookup();
    const attempt = pinnedFetch(
      `http://rebind.example.org:${server.port}/api/`,
      { signal: AbortSignal.timeout(400) },
      { lookup },
    );
    await expect(attempt).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
    expect(hits).toBe(0);
  });

  it("rejects hosts with any private answer before connecting", async () => {
    const lookup: Lookup = async () => [
      { address: "203.0.113.7", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(
      pinnedFetch("http://mixed.example.org/", {}, { lookup }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    await expect(pinnedFetch("http://127.0.0.1:1/", {})).rejects.toBeInstanceOf(
      PrivateNetworkError,
    );
    await expect(
      pinnedFetch(
        "http://gone.example.org/",
        {},
        {
          lookup: async () => {
            throw new Error("ENOTFOUND");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "dns" });
  });
});

describe("pinnedFetch pinning", () => {
  it("hands exactly the first, validated answer to the connection step", async () => {
    const { lookup, calls } = rebindingLookup();
    const seen: Array<{ address: string; family: number }[]> = [];
    const res = await pinnedFetch(
      "http://rebind.example.org/x",
      {},
      {
        lookup,
        requester: async (_url, _init, addresses) => {
          seen.push(addresses);
          return new Response("ok");
        },
      },
    );
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([[{ address: "203.0.113.7", family: 4 }]]);
  });

  it("blocks private IPv6 literals and mapped forms", async () => {
    for (const host of [
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[fe80::1]",
      "[fd00::1]",
    ]) {
      await expect(
        pinnedFetch(`http://${host}:9/`, {}),
        host,
      ).rejects.toMatchObject({ code: "blocked_address" });
    }
  });

  it("passes a public IPv6 literal through without a lookup", async () => {
    const seen: Array<{ address: string; family: number }[]> = [];
    await pinnedFetch(
      "http://[2001:db8::7]:8080/x",
      {},
      {
        lookup: async () => {
          throw new Error("must not resolve a literal");
        },
        requester: async (_url, _init, addresses) => {
          seen.push(addresses);
          return new Response(null);
        },
      },
    );
    expect(seen).toEqual([[{ address: "2001:db8::7", family: 6 }]]);
  });
});

describe("requestPinned", () => {
  it("connects to the given address, not to another one on the same port", async () => {
    const first = serve(() => new Response("on 127.0.0.1"));
    let second: { stop(force?: boolean): void };
    try {
      second = Bun.serve({
        port: first.port,
        hostname: "127.0.0.2",
        fetch: () => new Response("on 127.0.0.2"),
      });
    } catch {
      return; // this host has no 127.0.0.2 loopback alias
    }
    servers.push(second);
    const url = `http://docs.example.org:${first.port}/`;
    const a = await requestPinned(url, {}, [
      { address: "127.0.0.1", family: 4 },
    ]);
    const b = await requestPinned(url, {}, [
      { address: "127.0.0.2", family: 4 },
    ]);
    expect(await a.text()).toBe("on 127.0.0.1");
    expect(await b.text()).toBe("on 127.0.0.2");
  });

  it("reaches an IPv6 literal host", async () => {
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        port: 0,
        hostname: "::1",
        fetch: () => new Response("v6"),
      });
    } catch {
      return; // no IPv6 loopback here
    }
    servers.push(server);
    const res = await requestPinned(`http://[::1]:${server.port}/`, {}, [
      { address: "::1", family: 6 },
    ]);
    expect(await res.text()).toBe("v6");
  });

  it("asks for an uncompressed body", async () => {
    let encoding: string | null = null;
    const server = serve((req) => {
      encoding = req.headers.get("accept-encoding");
      return new Response("x");
    });
    await requestPinned(
      `http://docs.example.org:${server.port}/`,
      { headers: { "accept-encoding": "gzip" } },
      [{ address: "127.0.0.1", family: 4 }],
    );
    expect(encoding).toBe("identity");
  });

  it("reports the signal's reason when a timeout hits after the headers", async () => {
    const server = serve(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
            },
          }),
        ),
    );
    const res = await requestPinned(
      `http://docs.example.org:${server.port}/`,
      { signal: AbortSignal.timeout(200) },
      [{ address: "127.0.0.1", family: 4 }],
    );
    expect(res.status).toBe(200);
    const err = await res.text().catch((e) => e);
    expect(err).toMatchObject({ name: "TimeoutError" });
  });

  it("serves https with certificate verification and the pinned address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kept-tls-"));
    try {
      const made = Bun.spawnSync([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=docs.example.org",
        "-addext",
        "subjectAltName=DNS:docs.example.org",
      ]);
      if (made.exitCode !== 0) return; // openssl unavailable
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: {
          key: Bun.file(join(dir, "k.pem")),
          cert: Bun.file(join(dir, "c.pem")),
        },
        fetch: () => new Response("secure"),
      });
      servers.push(server);
      const url = `https://docs.example.org:${server.port}/`;
      const addresses = [{ address: "127.0.0.1", family: 4 }];
      await expect(requestPinned(url, {}, addresses)).rejects.toMatchObject({
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
      const ok = await requestPinned(
        url,
        { allowInsecureTls: true },
        addresses,
      );
      expect(await ok.text()).toBe("secure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("connects to the given address, keeps the host name and sends method, headers and body", async () => {
    let seen: { host: string | null; auth: string | null; body: string } = {
      host: null,
      auth: null,
      body: "",
    };
    const server = serve(async (req) => {
      seen = {
        host: req.headers.get("host"),
        auth: req.headers.get("authorization"),
        body: await req.text(),
      };
      return new Response('{"ok":true}', {
        status: 201,
        headers: { "x-version": "2.0", "content-type": "application/json" },
      });
    });
    const res = await requestPinned(
      `http://docs.example.org:${server.port}/api/x/?a=1`,
      {
        method: "POST",
        headers: { Authorization: "Token t", "Content-Type": "text/plain" },
        body: "payload",
      },
      [{ address: "127.0.0.1", family: 4 }],
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-version")).toBe("2.0");
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual({
      host: `docs.example.org:${server.port}`,
      auth: "Token t",
      body: "payload",
    });
  });

  it("sends FormData as multipart", async () => {
    let type = "";
    const server = serve(async (req) => {
      type = req.headers.get("content-type") ?? "";
      const form = await req.formData();
      return new Response(String(form.get("a")));
    });
    const form = new FormData();
    form.set("a", "b");
    const res = await requestPinned(
      `http://docs.example.org:${server.port}/`,
      { method: "POST", body: form },
      [{ address: "127.0.0.1", family: 4 }],
    );
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    expect(await res.text()).toBe("b");
  });

  it("returns redirects instead of following them and handles empty bodies", async () => {
    const server = serve((req) =>
      new URL(req.url).pathname === "/empty"
        ? new Response(null, { status: 204 })
        : new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:1/" },
          }),
    );
    const base = `http://docs.example.org:${server.port}`;
    const addresses = [{ address: "127.0.0.1", family: 4 }];
    const redirect = await requestPinned(`${base}/r`, {}, addresses);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("http://127.0.0.1:1/");
    const empty = await requestPinned(`${base}/empty`, {}, addresses);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });

  it("aborts when the signal fires", async () => {
    const server = serve(() => new Promise<Response>(() => undefined));
    await expect(
      requestPinned(
        `http://docs.example.org:${server.port}/`,
        { signal: AbortSignal.timeout(150) },
        [{ address: "127.0.0.1", family: 4 }],
      ),
    ).rejects.toMatchObject({ name: expect.stringMatching(/Abort|Timeout/) });
  });
});
