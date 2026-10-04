import { describe, expect, it } from "vitest";
import { isApiPath, isPublicPath, safeRedirectTo } from "./routing";

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
