import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSecretKeyConfigured,
  decryptSecret,
  encryptSecret,
  resetCryptoWarningForTests,
} from "./crypto";

const keyA = Buffer.alloc(32, 1).toString("base64");
const keyB = Buffer.alloc(32, 2).toString("base64");

describe("crypto", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetCryptoWarningForTests();
  });

  it("round-trips, including unicode and empty strings", () => {
    for (const text of ["hello", "", "grüezi ✓ 日本"]) {
      expect(decryptSecret(encryptSecret(text))).toBe(text);
    }
  });

  it("uses a versioned format and a fresh IV every time", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(a.split(".")).toHaveLength(3);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("same");
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, body] = encryptSecret("secret").split(".");
    const bytes = Buffer.from(body, "base64url");
    bytes[0] ^= 1;
    expect(() =>
      decryptSecret(`${v}.${iv}.${bytes.toString("base64url")}`),
    ).toThrow(/tampered/);
  });

  it("rejects a wrong key", () => {
    const enc = encryptSecret("secret");
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    expect(() => decryptSecret(enc)).toThrow(/wrong/);
  });

  it("rejects malformed payloads and unknown versions", () => {
    expect(() => decryptSecret("garbage")).toThrow(/malformed/);
    expect(() => decryptSecret("v2.aaaa.bbbb")).toThrow(/malformed/);
    expect(() => decryptSecret("v1.aa.bb")).toThrow(/malformed/);
  });

  it("rejects an invalid key", () => {
    vi.stubEnv("KEPT_SECRET_KEY", "not-a-valid-key");
    expect(() => assertSecretKeyConfigured()).toThrow(/openssl rand/);
    vi.stubEnv("KEPT_SECRET_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => assertSecretKeyConfigured()).toThrow(/invalid/);
  });

  it("throws in production when the key is missing or invalid", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KEPT_SECRET_KEY", "");
    expect(() => assertSecretKeyConfigured()).toThrow(/not set/);
    vi.stubEnv("KEPT_SECRET_KEY", "short");
    expect(() => assertSecretKeyConfigured()).toThrow(/invalid/);
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
    expect(() => assertSecretKeyConfigured()).not.toThrow();
  });

  it("falls back to a dev key outside production and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("KEPT_SECRET_KEY", "");
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
    encryptSecret("y");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
