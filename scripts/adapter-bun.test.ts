import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVICE_WORKER_PATH,
  withServiceWorkerHeaders,
} from "./adapter-bun.js";

const adapterHandler = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.resolve("svelte-adapter-bun"))),
    "files/handler.js",
  ),
  "utf8",
);

function staticHeaders() {
  const patched = withServiceWorkerHeaders(adapterHandler);
  const source = patched.match(
    /setHeaders: client \? (\(headers, pathname\) => \{[\s\S]*?\n {6}\}) : undefined/,
  )?.[1];
  expect(source).toBeDefined();
  const setHeaders = new Function("manifest", `return ${source}`)({
    appDir: "_app",
  }) as (headers: Headers, pathname: string) => Headers;
  return (pathname: string) => setHeaders(new Headers(), pathname);
}

describe("SERVICE_WORKER_PATH", () => {
  it("matches the service worker and its workbox runtime only", () => {
    for (const path of ["/sw.js", "/workbox-e74cd7e3.js"]) {
      expect(SERVICE_WORKER_PATH.test(path), path).toBe(true);
    }
    for (const path of [
      "/sw.js.map",
      "/sw.json",
      "/workbox-e74cd7e3.js.map",
      "/_app/immutable/chunks/sw.js",
      "/_app/immutable/workbox-e74cd7e3.js",
      "/service-worker.js",
      "/offline.html",
      "/",
    ]) {
      expect(SERVICE_WORKER_PATH.test(path), path).toBe(false);
    }
  });
});

describe("withServiceWorkerHeaders", () => {
  it("makes browsers and proxies revalidate the service worker scripts", () => {
    const headersFor = staticHeaders();
    expect(headersFor("/sw.js").get("cache-control")).toBe("no-cache");
    expect(headersFor("/workbox-e74cd7e3.js").get("cache-control")).toBe(
      "no-cache",
    );
  });

  it("keeps hashed assets immutable and leaves other files alone", () => {
    const headersFor = staticHeaders();
    expect(
      headersFor("/_app/immutable/chunks/AbCd1234.js").get("cache-control"),
    ).toBe("public,max-age=31536000,immutable");
    expect(headersFor("/favicon.ico").has("cache-control")).toBe(false);
    expect(headersFor("/offline.html").has("cache-control")).toBe(false);
  });

  it("refuses to patch a handler it does not recognise", () => {
    expect(() => withServiceWorkerHeaders("export {};")).toThrow(
      /svelte-adapter-bun changed/,
    );
  });
});
