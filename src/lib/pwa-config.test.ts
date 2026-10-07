import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRECACHE_GLOBS, pwaOptions } from "./pwa-config";

const workbox = pwaOptions.workbox ?? {};
const routes = workbox.runtimeCaching ?? [];

const precached = (path: string) =>
  PRECACHE_GLOBS.some((glob) => new Bun.Glob(glob).match(path));

const matchingRoutes = (path: string, mode: string) =>
  routes.filter((route) => {
    expect(route.urlPattern).toBeTypeOf("function");
    const match = route.urlPattern as (ctx: unknown) => boolean;
    return match({
      request: { mode, url: `http://kept.test${path}` },
      url: new URL(path, "http://kept.test"),
    });
  });

const SESSION_PATHS = [
  "/",
  "/accounts",
  "/accounts/1",
  "/accounts/1/__data.json",
  "/__data.json",
  "/bills/1/document",
  "/institutions/1/logo",
  "/api/health",
  "/api/pillar-3a/anything",
  "/reports/statement.pdf",
  "/settings/preferences?/setBlur",
  "/login",
  "/logout",
];

describe("registration", () => {
  it("prompts for updates and registers from the layout, not an inline script", () => {
    expect(pwaOptions.registerType).toBe("prompt");
    expect(pwaOptions.injectRegister).toBe(false);
  });

  it("keeps the manifest in static/", () => {
    expect(pwaOptions.manifest).toBe(false);
    expect(existsSync("static/site.webmanifest")).toBe(true);
  });

  it("waits for the user instead of taking over open tabs", () => {
    expect(workbox.skipWaiting).toBeFalsy();
    expect(workbox.clientsClaim).toBeFalsy();
  });
});

describe("precache", () => {
  it("holds the build's static assets, icons and the offline page", () => {
    for (const path of [
      "client/_app/immutable/entry/start.AbCd1234.js",
      "client/_app/immutable/chunks/AbCd1234.js",
      "client/_app/immutable/nodes/3.AbCd1234.js",
      "client/_app/immutable/assets/0.AbCd1234.css",
      "client/_app/immutable/assets/inter-latin-wght-normal.AbCd1234.woff2",
      "client/brand/kept-symbol-small.svg",
      "client/favicon.svg",
      "client/favicon.ico",
      "client/icon-192.png",
      "client/maskable-512.png",
      "client/apple-touch-icon.png",
      "client/theme-init.js",
      "client/offline.html",
      "client/offline.css",
    ]) {
      expect(precached(path), path).toBe(true);
    }
  });

  it("holds no page, data, API, document, logo or service worker file", () => {
    for (const path of [
      "prerendered/pages/index.html",
      "prerendered/pages/login.html",
      "client/index.html",
      "client/accounts/__data.json",
      "client/_app/version.json",
      "client/_app/env.js",
      "client/_app/immutable/nodes/3.AbCd1234.js.map",
      "client/site.webmanifest",
      "client/sw.js",
      "client/workbox-e74cd7e3.js",
      "server/index.js",
      "client/api/health",
      "client/bills/1/document",
      "client/institutions/1/logo",
    ]) {
      expect(precached(path), path).toBe(false);
    }
  });

  it("does not let the SvelteKit plugin add prerendered pages or the manifest", () => {
    expect(workbox.modifyURLPrefix).toEqual({ "client/": "" });
    expect(workbox.manifestTransforms).toEqual([]);
    expect(PRECACHE_GLOBS.some((glob) => glob.includes("prerendered"))).toBe(
      false,
    );
  });

  it("covers everything the offline page loads", () => {
    const html = readFileSync("static/offline.html", "utf8");
    const refs = [...html.matchAll(/\s(?:href|src)="(\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(refs).toContain("/offline.css");
    for (const ref of refs) {
      expect(existsSync(`static${ref}`), ref).toBe(true);
      expect(precached(`client${ref}`), ref).toBe(true);
    }
  });
});

describe("runtime caching", () => {
  it("never stores a response: every route is network-only", () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.handler).toBe("NetworkOnly");
      expect(route.options?.cacheName).toBeUndefined();
    }
  });

  it("does not route anything but navigations", () => {
    for (const path of SESSION_PATHS) {
      expect(matchingRoutes(path, "cors"), path).toHaveLength(0);
      expect(matchingRoutes(path, "same-origin"), path).toHaveLength(0);
    }
    expect(matchingRoutes("/accounts", "navigate")).toHaveLength(1);
  });

  it("has no navigation fallback to a cached app shell", () => {
    expect("navigateFallback" in workbox).toBe(true);
    expect(workbox.navigateFallback).toBeUndefined();
  });
});

describe("offline fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves the precached offline page when a navigation fails", async () => {
    const offline = new Response("offline");
    const match = vi.fn().mockResolvedValue(offline);
    vi.stubGlobal("caches", { match });
    const plugin = routes[0]?.options?.plugins?.[0];
    const didError = plugin?.handlerDidError as (() => unknown) | undefined;
    expect(didError).toBeTypeOf("function");
    await expect(didError?.()).resolves.toBe(offline);
    expect(match).toHaveBeenCalledWith("/offline.html", {
      ignoreSearch: true,
    });
  });
});

describe("static/offline.html", () => {
  const html = readFileSync("static/offline.html", "utf8");

  it("runs no inline script", () => {
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
      expect(tag).toMatch(/\ssrc=/i);
    }
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("restricts itself to same-origin files, as the static server sends no CSP", () => {
    expect(html).toMatch(
      /http-equiv="Content-Security-Policy"\s+content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'"/,
    );
  });
});
