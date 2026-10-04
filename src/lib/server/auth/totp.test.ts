import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "./totp";

// RFC 6238 appendix B secret ("12345678901234567890"), SHA-1, last 6 digits of the 8 digit vectors.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(totpCode(RFC_SECRET, 1_234_567_890_000)).toBe("005924");
    expect(totpCode(RFC_SECRET, 2_000_000_000_000)).toBe("279037");
  });

  it("round-trips base32", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
  });

  it("accepts the current step and one step of drift either way", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      const code = totpCode(RFC_SECRET, now + offset * 30_000);
      expect(verifyTotp(RFC_SECRET, code, now)).toBe(step + offset);
    }
  });

  it("rejects codes outside the window and malformed input", () => {
    const now = 1_700_000_000_000;
    for (const offset of [-2, 2]) {
      const code = totpCode(RFC_SECRET, now + offset * 30_000);
      expect(verifyTotp(RFC_SECRET, code, now)).toBeNull();
    }
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "", now)).toBeNull();
  });

  it("rejects a step that was already used (replay)", () => {
    const now = 1_700_000_000_000;
    const code = totpCode(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, step!)).toBeNull();
    // an older code in the window is also refused once a newer step was used
    const older = totpCode(RFC_SECRET, now - 30_000);
    expect(verifyTotp(RFC_SECRET, older, now, step!)).toBeNull();
  });

  it("builds an otpauth uri without leaking anything unexpected", () => {
    const uri = otpauthUri(RFC_SECRET, "alice");
    expect(uri).toContain("otpauth://totp/Kept:alice?");
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
