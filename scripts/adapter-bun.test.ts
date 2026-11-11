import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVICE_WORKER_FILE,
  withServiceWorkerHeaders,
} from "./adapter-bun.js";

const assetsSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.resolve("@sveltejs/adapter-bun"))),
    "src/assets.js",
  ),
  "utf8",
);

const CLIENT = "/app/build/client/";

function staticHeaders() {
  const patched = withServiceWorkerHeaders(assetsSource);
  const statement = patched.match(/if \(immutable\) [^\n]*no-cache[^\n]*/)?.[0];
  expect(statement).toBeDefined();
  const headersFor = new Function(
    "file",
    "immutable",
    `const base_headers = {}; ${statement} return base_headers;`,
  ) as (file: string, immutable: boolean) => Record<string, string>;
  return (url: string) =>
    headersFor(CLIENT + url, url.startsWith("_app/immutable/"));
}

describe("SERVICE_WORKER_FILE", () => {
  it("matches the service worker and its workbox runtime only", () => {
    for (const path of ["sw.js", "workbox-e74cd7e3.js"]) {
      expect(SERVICE_WORKER_FILE.test(CLIENT + path), path).toBe(true);
      expect(
        SERVICE_WORKER_FILE.test(`C:\\app\\build\\client\\${path}`),
        path,
      ).toBe(true);
    }
    for (const path of [
      "sw.js.map",
      "sw.json",
      "workbox-e74cd7e3.js.map",
      "_app/immutable/chunks/sw.js",
      "_app/immutable/workbox-e74cd7e3.js",
      "service-worker.js",
      "offline.html",
      "index.html",
    ]) {
      expect(SERVICE_WORKER_FILE.test(CLIENT + path), path).toBe(false);
    }
    expect(SERVICE_WORKER_FILE.test("/app/build/prerendered/sw.js")).toBe(
      false,
    );
  });
});

describe("withServiceWorkerHeaders", () => {
  it("makes browsers and proxies revalidate the service worker scripts", () => {
    const headersFor = staticHeaders();
    expect(headersFor("sw.js")["cache-control"]).toBe("no-cache");
    expect(headersFor("workbox-e74cd7e3.js")["cache-control"]).toBe("no-cache");
  });

  it("keeps hashed assets immutable and leaves other files alone", () => {
    const headersFor = staticHeaders();
    expect(
      headersFor("_app/immutable/chunks/AbCd1234.js")["cache-control"],
    ).toBe("public,max-age=31536000,immutable");
    expect(headersFor("_app/immutable/chunks/sw.js")["cache-control"]).toBe(
      "public,max-age=31536000,immutable",
    );
    expect(headersFor("favicon.ico")["cache-control"]).toBeUndefined();
    expect(headersFor("offline.html")["cache-control"]).toBeUndefined();
  });

  it("patches the bundled form of the adapter too", () => {
    const bundled = `function file_entry(file, meta, immutable = false) {
	if (immutable) base_headers["cache-control"] = "public,max-age=31536000,immutable";
}`;
    expect(withServiceWorkerHeaders(bundled)).toContain(
      'base_headers["cache-control"] = "no-cache";',
    );
  });

  it("refuses to patch a source it does not recognise", () => {
    expect(() => withServiceWorkerHeaders("export {};")).toThrow(
      /@sveltejs\/adapter-bun changed/,
    );
    expect(() =>
      withServiceWorkerHeaders(
        assetsSource.replace("function file_entry(file,", "function f(path,"),
      ),
    ).toThrow(/@sveltejs\/adapter-bun changed/);
  });
});
