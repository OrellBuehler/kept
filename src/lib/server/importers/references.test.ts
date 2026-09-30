import { describe, expect, it } from "vitest";
import {
  detectReference,
  isValidCreditorReference,
  isValidQrReference,
} from "./references";
import {
  SCOR,
  SCOR_BAD_CHECK,
  SCOR_LOWER,
  SCOR_LOWER_SPACED,
  SCOR_SPACED,
} from "../../testing/fixtures/values";

describe("isValidQrReference", () => {
  it("accepts the documented example reference", () => {
    expect(isValidQrReference("210000000003139471430009017")).toBe(true);
    expect(isValidQrReference("21 00000 00003 13947 14300 09017")).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidQrReference("210000000003139471430009018")).toBe(false);
  });

  it("rejects wrong length and non-digits", () => {
    expect(isValidQrReference("2100000000031394714300090")).toBe(false);
    expect(isValidQrReference("21000000000313947143000901X")).toBe(false);
  });
});

describe("isValidCreditorReference", () => {
  it("accepts ISO 11649 references, with or without spaces", () => {
    expect(isValidCreditorReference(SCOR)).toBe(true);
    expect(isValidCreditorReference(SCOR_SPACED)).toBe(true);
    expect(isValidCreditorReference(SCOR_LOWER)).toBe(true);
  });

  it("rejects a wrong check", () => {
    expect(isValidCreditorReference(SCOR_BAD_CHECK)).toBe(false);
    expect(isValidCreditorReference("RF18")).toBe(false);
    expect(isValidCreditorReference(SCOR.replace("RF", "XX"))).toBe(false);
  });
});

describe("detectReference", () => {
  it("normalizes QRR and SCOR", () => {
    expect(detectReference(" 21 00000 00003 13947 14300 09017 ")).toEqual({
      reference: "210000000003139471430009017",
      referenceType: "QRR",
    });
    expect(detectReference(SCOR_LOWER_SPACED)).toEqual({
      reference: SCOR,
      referenceType: "SCOR",
    });
  });

  it("keeps unknown references untouched", () => {
    expect(detectReference(" INV-2024-7 ")).toEqual({
      reference: "INV-2024-7",
      referenceType: null,
    });
  });
});
