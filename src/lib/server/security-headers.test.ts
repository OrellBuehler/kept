import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../../svelte.config.js";
import {
  FALLBACK_CSP,
  applySecurityHeaders,
  withSecurityHeaders,
} from "./security-headers";

const http = new URL("http://kept.test/");
const https = new URL("https://kept.test/");

describe("applySecurityHeaders", () => {
  it("sets the baseline headers", () => {
    const h = new Headers();
    applySecurityHeaders(h, http);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("same-origin");
    expect(h.get("permissions-policy")).toContain("camera=()");
    expect(h.get("content-security-policy")).toBe(FALLBACK_CSP);
    expect(h.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("sends HSTS only over https", () => {
    const plain = new Headers();
    applySecurityHeaders(plain, http);
    expect(plain.has("strict-transport-security")).toBe(false);
    const secure = new Headers();
    applySecurityHeaders(secure, https);
    expect(secure.get("strict-transport-security")).toMatch(/^max-age=\d+$/);
  });

  it("keeps a CSP the route already set", () => {
    const h = new Headers({
      "content-security-policy": "default-src 'none'; frame-ancestors 'self'",
    });
    applySecurityHeaders(h, http);
    expect(h.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    );
  });

  it("rebuilds responses whose headers are immutable", () => {
    const res = Response.redirect("http://kept.test/x", 303);
    const out = withSecurityHeaders(res, http);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("http://kept.test/x");
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("kit.csp", () => {
  const csp = config.kit?.csp;

  it("uses auto mode so SvelteKit's inline bootstrap gets a nonce or hash", () => {
    expect(csp?.mode).toBe("auto");
  });

  it("locks the document down", () => {
    const d = csp?.directives ?? {};
    expect(d["default-src"]).toEqual(["self"]);
    expect(d["img-src"]).toEqual(["self", "data:", "blob:"]);
    expect(d["frame-ancestors"]).toEqual(["none"]);
    expect(d["object-src"]).toEqual(["none"]);
    expect(d["base-uri"]).toEqual(["self"]);
    expect(d["form-action"]).toEqual(["self"]);
  });

  it("never allows inline or eval scripts", () => {
    const script = csp?.directives?.["script-src"] ?? [];
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
  });
});

describe("no inline scripts outside SvelteKit's own", () => {
  it("app.html only references external scripts", () => {
    const html = readFileSync("src/app.html", "utf8");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag).toMatch(/\ssrc=/);
    }
  });

  it("the root layout disables mode-watcher's injected inline script", () => {
    const layout = readFileSync("src/routes/+layout.svelte", "utf8");
    expect(layout).toMatch(/<ModeWatcher[^>]*disableHeadScriptInjection/);
    expect(readFileSync("static/theme-init.js", "utf8")).toContain(
      "mode-watcher-mode",
    );
  });
});
