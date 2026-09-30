import { describe, expect, it } from "vitest";
import {
  BAD_QRR_CHECK,
  BAD_SCOR_CHECK,
  BAD_SCOR_PREFIX,
  BAD_SCOR_TOO_LONG,
  EXAMPLE_QRR,
  EXAMPLE_SCOR,
  EXAMPLE_SCOR_FORMATTED,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  formatReference,
  isValidQrr,
  isValidScor,
  normalizeReference,
} from "./references";

describe("references", () => {
  it("validates QRR check digit", () => {
    expect(isValidQrr(EXAMPLE_QRR)).toBe(true);
    expect(isValidQrr(formatReference(EXAMPLE_QRR))).toBe(true);
    expect(isValidQrr("000000000000000000000000000")).toBe(true);
    expect(isValidQrr(BAD_QRR_CHECK)).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR.slice(0, -1))).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR + "0")).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR.slice(0, -1) + "A")).toBe(false);
  });

  it("validates SCOR references", () => {
    expect(isValidScor(EXAMPLE_SCOR)).toBe(true);
    expect(isValidScor(formatReference(EXAMPLE_SCOR).toLowerCase())).toBe(true);
    expect(isValidScor(BAD_SCOR_CHECK)).toBe(false);
    expect(isValidScor("RF18")).toBe(false);
    expect(isValidScor(BAD_SCOR_TOO_LONG)).toBe(false);
    expect(isValidScor(BAD_SCOR_PREFIX)).toBe(false);
  });

  it("normalizes and formats", () => {
    expect(normalizeReference(" rf18 5390 ")).toBe("RF185390");
    expect(formatReference(EXAMPLE_QRR)).toBe(
      "21 00000 00003 13947 14300 09017",
    );
    expect(formatReference(EXAMPLE_SCOR)).toBe(EXAMPLE_SCOR_FORMATTED);
  });
});
