import { describe, expect, it } from "vitest";
import {
  isApiPath,
  isExternalApiPath,
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
