import { describe, expect, it } from "vitest";
import {
  BAD_FOREIGN_IBAN_CHECK,
  BAD_IBAN_CHECK,
  BAD_IBAN_SHORT,
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
  FOREIGN_IBANS,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  formatIban,
  isQrIban,
  isValidIban,
  maskIban,
  normalizeIban,
} from "./iban";

describe("iban", () => {
  it("normalizes", () => {
    expect(normalizeIban(` ${formatIban(EXAMPLE_IBAN).toLowerCase()} `)).toBe(
      EXAMPLE_IBAN,
    );
  });

  it("validates documented examples", () => {
    for (const iban of [
      EXAMPLE_IBAN,
      EXAMPLE_IBAN_OTHER,
      EXAMPLE_IBAN_THIRD,
      ...FOREIGN_IBANS,
    ]) {
      expect(isValidIban(iban), iban).toBe(true);
      expect(isValidIban(formatIban(iban)), iban).toBe(true);
    }
  });

  it("rejects bad check digits, lengths and junk", () => {
    expect(isValidIban(BAD_IBAN_CHECK)).toBe(false);
    expect(isValidIban(BAD_IBAN_SHORT)).toBe(false);
    expect(isValidIban(BAD_FOREIGN_IBAN_CHECK)).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban("1234")).toBe(false);
    expect(isValidIban(EXAMPLE_IBAN.replace(/(....)/g, "$1-"))).toBe(false);
  });

  it("formats in groups of four", () => {
    expect(formatIban(EXAMPLE_IBAN)).toBe(
      EXAMPLE_IBAN.replace(/(.{4})(?=.)/g, "$1 "),
    );
  });

  it("masks keeping country, check digits and last four", () => {
    expect(maskIban(EXAMPLE_IBAN)).toBe("CH93 •••• •••• •••• •295 7");
  });

  it("masks short inputs completely", () => {
    expect(maskIban("CH93")).toBe("••••");
    expect(maskIban("CH9300762")).toBe("•••• •••• •");
    expect(maskIban("")).toBe("");
  });

  it("detects QR-IBANs by IID range", () => {
    expect(isQrIban(EXAMPLE_IBAN_OTHER)).toBe(true);
    expect(isQrIban(formatIban(EXAMPLE_IBAN_OTHER))).toBe(true);
    expect(isQrIban(EXAMPLE_IBAN)).toBe(false);
    expect(isQrIban(EXAMPLE_IBAN_THIRD)).toBe(false);
    expect(isQrIban(FOREIGN_IBANS[0])).toBe(false);
  });
});
