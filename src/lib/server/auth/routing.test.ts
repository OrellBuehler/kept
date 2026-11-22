import { describe, expect, it } from "vitest";
import {
  isApiPath,
  isAppApiPath,
  isExternalApiPath,
  isMcpPath,
  isPublicAppApiPath,
  isCrossOriginPath,
  isPublicPath,
  safeRedirectTo,
} from "./routing";

describe("safeRedirectTo", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeRedirectTo("/admin/users")).toBe("/admin/users");
    expect(safeRedirectTo("/a?b=1&c=2#x")).toBe("/a?b=1&c=2#x");
  });

  it("falls back to / for missing values", () => {
    expect(safeRedirectTo(null)).toBe("/");
    expect(safeRedirectTo(undefined)).toBe("/");
    expect(safeRedirectTo("")).toBe("/");
  });

  it("rejects external and tricky targets", () => {
    for (const bad of [
      "//evil.com",
      "//evil.com/path",
      "https://evil.com",
      "http://evil.com/x",
      "javascript:alert(1)",
      "/\\evil.com",
      "\\\\evil.com",
      "evil.com",
      "/a\r\nSet-Cookie: x=1",
      "/\tfoo",
    ]) {
      expect(safeRedirectTo(bad), bad).toBe("/");
    }
  });
});

describe("path classification", () => {
  it("knows the public paths", () => {
    for (const p of [
      "/login",
      "/login/verify",
      "/setup",
      "/api/health",
      "/api/public/hook",
      "/api/auth/passkey/login/options",
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of [
      "/",
      "/api",
      "/api/publicity",
      "/login/x",
      "/api/auth/passkey/register/options",
      "/admin/users",
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("detects api paths", () => {
    expect(isApiPath("/api/x")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
  });
});

describe("isExternalApiPath", () => {
  it("matches the prefix and everything under it", () => {
    for (const p of [
      "/api/external/v1",
      "/api/external/v1/",
      "/api/external/v1/me",
      "/api/external/v1/bills/abc/links",
      "/api/%65xternal/v1/me",
      "/api/external/%76%31/me",
    ]) {
      expect(isExternalApiPath(p), p).toBe(true);
    }
  });

  it("does not match lookalikes or other APIs", () => {
    for (const p of [
      "/",
      "/api",
      "/api/external",
      "/api/external/v2/me",
      "/api/externalx/v1/me",
      "/api/external/v10/me",
      "/api/public/external/v1",
      "/x/api/external/v1",
      "/api/health",
      "/api/%E0%A4%A",
    ]) {
      expect(isExternalApiPath(p), p).toBe(false);
    }
  });

  it("is not public: the hook authenticates it separately", () => {
    expect(isPublicPath("/api/external/v1/me")).toBe(false);
    expect(isApiPath("/api/external/v1/me")).toBe(true);
  });
});

describe("isMcpPath", () => {
  it("matches the endpoint and everything under it, in any spelling", () => {
    for (const p of [
      "/api/mcp",
      "/api/mcp/",
      "/api/mcp/anything",
      "/api/%6dcp",
      "/api/mcp/%2e%2e",
    ]) {
      expect(isMcpPath(p), p).toBe(true);
    }
  });

  it("does not match lookalikes or other APIs", () => {
    for (const p of [
      "/",
      "/api",
      "/api/mcpx",
      "/api/mcp2",
      "/api/public/mcp",
      "/x/api/mcp",
      "/api/external/v1/mcp",
      "/api/%E0%A4%A",
    ]) {
      expect(isMcpPath(p), p).toBe(false);
    }
  });

  it("is not public: the hook authenticates it separately", () => {
    expect(isPublicPath("/api/mcp")).toBe(false);
    expect(isApiPath("/api/mcp")).toBe(true);
  });
});

describe("isAppApiPath", () => {
  it("matches the prefix and everything under it, in any spelling", () => {
    for (const p of [
      "/api/app/v1",
      "/api/app/v1/",
      "/api/app/v1/session",
      "/api/app/v1/server/",
      "/api/app/v1//server",
      "/api/%61pp/v1/pages/bills",
      "/api/app/%76%31/session",
      "/api/app/v1/%E0%A4%A",
    ]) {
      expect(isAppApiPath(p), p).toBe(true);
    }
  });

  it("does not match lookalikes or other APIs", () => {
    for (const p of [
      "/",
      "/api",
      "/api/app",
      "/api/app/v2/session",
      "/api/app/v10/server",
      "/api/application/x",
      "/api/appx/v1/session",
      "/api/external/v1/me",
      "/x/api/app/v1",
      "/api/%E0%A4%A",
    ]) {
      expect(isAppApiPath(p), p).toBe(false);
    }
  });
});

describe("isPublicAppApiPath", () => {
  it("is true for discovery and the sign-in steps only", () => {
    for (const p of [
      "/api/app/v1/server",
      "/api/app/v1/auth/login",
      "/api/app/v1/auth/verify",
      "/api/app/v1/auth/browser",
      "/api/app/v1/auth/browser/token",
      "/api/app/v1/%73erver",
      "/api/%61pp/v1/%73erver",
    ]) {
      expect(isPublicAppApiPath(p), p).toBe(true);
    }
  });

  it("is false for every other spelling and path", () => {
    for (const p of [
      "/api/app/v1",
      "/api/app/v1/",
      "/api/app/v1/session",
      "/api/app/v1/auth/logout",
      "/api/app/v1/auth/browser/",
      "/api/app/v1/auth/browser/other",
      "/api/app/v1/server/",
      "/api/app/v1//server",
      "/api/app/v1/Server",
      "/api/app/v1/server;x",
      "/api/app/v1/auth%2Flogin",
      "/api/app/v1/%2573erver",
      "/api/app/v1/server/extra",
      "/api/app/v1/%E0%A4%A",
      "/api/app/v10/server",
      "/server",
    ]) {
      expect(isPublicAppApiPath(p), p).toBe(false);
    }
  });

  it("is not a public path of the web", () => {
    expect(isPublicPath("/api/app/v1/server")).toBe(false);
    expect(isApiPath("/api/app/v1/server")).toBe(true);
  });
});

describe("the OAuth endpoints", () => {
  it("makes public what a client calls itself, and the metadata documents", () => {
    for (const path of [
      "/oauth/register",
      "/oauth/token",
      "/oauth/revoke",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect(isPublicPath(path), path).toBe(true);
    }
  });

  it("keeps the consent page behind the owner's session", () => {
    for (const path of [
      "/oauth/authorize",
      "/oauth/authorize/",
      "/oauth",
      "/oauth/token/x",
      "/oauth/tokens",
      "/.well-known/oauth-protected-resourceX",
      "/.well-known/other",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("exempts only the three client endpoints and the exact MCP path from the form-post origin check", () => {
    expect(
      ["/oauth/register", "/oauth/token", "/oauth/revoke"].every(
        isCrossOriginPath,
      ),
    ).toBe(true);
    expect(isCrossOriginPath("/api/mcp")).toBe(true);
    for (const path of [
      "/oauth/authorize",
      "/login",
      "/api/mcp/",
      "/api/mcp/x",
      "/api/external/v1/bills",
      "/api/app/v1/pages/x",
      "/oauth/token/",
    ]) {
      expect(isCrossOriginPath(path), path).toBe(false);
    }
  });

  it("keeps the whole request through the login round trip", () => {
    const path =
      "/oauth/authorize?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&state=a%26b";
    expect(safeRedirectTo(path)).toBe(path);
  });
});
