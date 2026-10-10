import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVICE_WORKER_PATH,
  withRuntimeOrigin,
  withServiceWorkerHeaders,
} from "./adapter-bun.js";

const routesSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.resolve("@sveltejs/adapter-bun"))),
    "src/routes-util.js",
  ),
  "utf8",
);

function staticHeaders() {
  const patched = withServiceWorkerHeaders(routesSource);
  const expression = patched.match(/\bimmutable \? [^\n]*?\{\}(?=\n)/)?.[0];
  expect(expression).toBeDefined();
  const headersFor = new Function(
    "url",
    `const immutable = url.startsWith("_app/immutable/"); return ${expression};`,
  ) as (url: string) => Record<string, string>;
  return (url: string) => headersFor(url);
}

describe("SERVICE_WORKER_PATH", () => {
  it("matches the service worker and its workbox runtime only", () => {
    for (const path of ["sw.js", "workbox-e74cd7e3.js"]) {
      expect(SERVICE_WORKER_PATH.test(path), path).toBe(true);
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
      expect(SERVICE_WORKER_PATH.test(path), path).toBe(false);
    }
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
    expect(headersFor("favicon.ico")["cache-control"]).toBeUndefined();
    expect(headersFor("offline.html")["cache-control"]).toBeUndefined();
  });

  it("refuses to patch a source it does not recognise", () => {
    expect(() => withServiceWorkerHeaders("export {};")).toThrow(
      /@sveltejs\/adapter-bun changed/,
    );
  });
});

describe("withRuntimeOrigin", () => {
  const evaluate = (source: string, env: Record<string, string>) =>
    new Function(
      "Bun",
      `${source.replace("export const origin", "const origin")}; return origin;`,
    )({ env });

  it("lets ORIGIN override the build-time origin, keeping only its origin part", () => {
    const patched = withRuntimeOrigin("export const origin = undefined;");
    expect(evaluate(patched, { ORIGIN: "https://kept.example.org/x/y" })).toBe(
      "https://kept.example.org",
    );
    expect(evaluate(patched, {})).toBeUndefined();
  });

  it("falls back to the origin the build configured", () => {
    const patched = withRuntimeOrigin(
      'export const origin = "https://built.example.org";',
    );
    expect(evaluate(patched, {})).toBe("https://built.example.org");
  });

  it("fails on an ORIGIN that is not a URL", () => {
    const patched = withRuntimeOrigin("export const origin = undefined;");
    expect(() => evaluate(patched, { ORIGIN: "kept.example.org" })).toThrow();
  });

  it("refuses to patch a source it does not recognise", () => {
    expect(() => withRuntimeOrigin("export {};")).toThrow(
      /@sveltejs\/adapter-bun changed/,
    );
  });
});
