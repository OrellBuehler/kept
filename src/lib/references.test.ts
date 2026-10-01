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
  detectReference,
  formatReference,
  isValidQrr,
  isValidScor,
  normalizeReference,
} from "./references";

const EXAMPLE_QRR_SPACED = formatReference(EXAMPLE_QRR);
const ZERO_QRR = "0".repeat(27);

describe("isValidQrr", () => {
  it("validates QRR check digit", () => {
    expect(isValidQrr(EXAMPLE_QRR)).toBe(true);
    expect(isValidQrr(EXAMPLE_QRR_SPACED)).toBe(true);
    expect(isValidQrr(ZERO_QRR)).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidQrr(BAD_QRR_CHECK)).toBe(false);
  });

  it("rejects wrong length and non-digits", () => {
    expect(isValidQrr(EXAMPLE_QRR.slice(0, -1))).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR.slice(0, -2))).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR + "0")).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR.slice(0, -1) + "A")).toBe(false);
    expect(isValidQrr(EXAMPLE_QRR.slice(0, -1) + "X")).toBe(false);
  });
});

describe("isValidScor", () => {
  it("validates SCOR references, with or without spaces and case", () => {
    expect(isValidScor(EXAMPLE_SCOR)).toBe(true);
    expect(isValidScor(EXAMPLE_SCOR_FORMATTED)).toBe(true);
    expect(isValidScor(EXAMPLE_SCOR.toLowerCase())).toBe(true);
    expect(isValidScor(EXAMPLE_SCOR_FORMATTED.toLowerCase())).toBe(true);
  });

  it("rejects a wrong check, length or prefix", () => {
    expect(isValidScor(BAD_SCOR_CHECK)).toBe(false);
    expect(isValidScor("RF18")).toBe(false);
    expect(isValidScor(BAD_SCOR_TOO_LONG)).toBe(false);
    expect(isValidScor(BAD_SCOR_PREFIX)).toBe(false);
  });
});

describe("normalizeReference", () => {
  it("strips whitespace and upper-cases", () => {
    expect(normalizeReference(" rf18 5390 ")).toBe("RF185390");
  });
});

describe("detectReference", () => {
  it("normalizes QRR and SCOR", () => {
    expect(detectReference(` ${EXAMPLE_QRR_SPACED} `)).toEqual({
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    expect(detectReference(EXAMPLE_SCOR_FORMATTED.toLowerCase())).toEqual({
      reference: EXAMPLE_SCOR,
      referenceType: "SCOR",
    });
  });

  it("keeps unknown references untouched", () => {
    expect(detectReference(" INV-2024-7 ")).toEqual({
      reference: "INV-2024-7",
      referenceType: null,
    });
    expect(detectReference(BAD_QRR_CHECK).referenceType).toBeNull();
    expect(detectReference(BAD_SCOR_CHECK).referenceType).toBeNull();
  });
});

describe("formatReference", () => {
  it("groups a 27 digit QR reference", () => {
    expect(formatReference(EXAMPLE_QRR)).toBe(
      "21 00000 00003 13947 14300 09017",
    );
    expect(formatReference(ZERO_QRR)).toBe("00 00000 00000 00000 00000 00000");
  });

  it("groups a creditor reference in fours", () => {
    expect(formatReference(EXAMPLE_SCOR)).toBe(EXAMPLE_SCOR_FORMATTED);
    expect(formatReference("rf12 abcd efgh")).toBe("RF12 ABCD EFGH");
  });

  it("leaves anything else alone", () => {
    expect(formatReference(" abc ")).toBe("abc");
  });
});
