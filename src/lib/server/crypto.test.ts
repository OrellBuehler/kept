import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSecretKeyConfigured,
  decryptSecret,
  encryptSecret,
  resetCryptoWarningForTests,
  SecretUnreadableError,
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

  it("signals an unreadable secret with a typed error under another key or bad format", () => {
    const enc = encryptSecret("secret");
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    expect(() => decryptSecret(enc)).toThrow(SecretUnreadableError);
    expect(() => decryptSecret("garbage")).toThrow(SecretUnreadableError);
    vi.stubEnv("KEPT_SECRET_KEY", "not-a-key");
    expect(() => decryptSecret(enc)).not.toThrow(SecretUnreadableError);
  });

  it("authenticates the version prefix as additional data", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 1), iv);
    const body = Buffer.concat([
      cipher.update("x"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const noAad = `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
    expect(() => decryptSecret(noAad)).toThrow(/tampered/);
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
    vi.stubEnv("DEV", false);
    vi.stubEnv("KEPT_SECRET_KEY", "");
    expect(() => assertSecretKeyConfigured()).toThrow(/not set/);
    vi.stubEnv("KEPT_SECRET_KEY", "short");
    expect(() => assertSecretKeyConfigured()).toThrow(/invalid/);
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
    expect(() => assertSecretKeyConfigured()).not.toThrow();
  });

  it("refuses the insecure key in a built server even without NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("DEV", false);
    vi.stubEnv("KEPT_SECRET_KEY", "");
    expect(() => assertSecretKeyConfigured()).toThrow(
      /KEPT_SECRET_KEY is not set/,
    );
    expect(() => encryptSecret("x")).toThrow(/not set/);
  });

  it("uses the insecure key in a built server only when KEPT_ALLOW_INSECURE_KEY=true", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DEV", false);
    vi.stubEnv("KEPT_SECRET_KEY", "");
    vi.stubEnv("KEPT_ALLOW_INSECURE_KEY", "yes");
    expect(() => assertSecretKeyConfigured()).toThrow(/not set/);
    vi.stubEnv("KEPT_ALLOW_INSECURE_KEY", "true");
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a configured key wins over the opt-in", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("KEPT_ALLOW_INSECURE_KEY", "true");
    const payload = encryptSecret("x");
    vi.stubEnv("KEPT_SECRET_KEY", "");
    expect(() => decryptSecret(payload)).toThrow(/Cannot decrypt/);
  });

  it("falls back to a dev key under vite dev and tests and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("KEPT_SECRET_KEY", "");
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
    encryptSecret("y");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
