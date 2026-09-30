import { describe, expect, it } from "vitest";
import {
  formatIban,
  isQrIban,
  isValidIban,
  maskIban,
  normalizeIban,
} from "./iban";

describe("iban", () => {
  it("normalizes", () => {
    expect(normalizeIban(" ch93 0076 2011 6238 5295 7 ")).toBe(
      "CH9300762011623852957",
    );
  });

  it("validates documented examples", () => {
    for (const iban of [
      "CH4431999123000889012",
      "CH9300762011623852957",
      "CH5604835012345678009",
      "DE89 3704 0044 0532 0130 00",
      "GB82WEST12345698765432",
      "FR1420041010050500013M02606",
      "NL91ABNA0417164300",
      "AT611904300234573201",
      "BE68539007547034",
      "ES9121000418450200051332",
      "IT60X0542811101000000123456",
      "SE4550000000058398257466",
    ]) {
      expect(isValidIban(iban), iban).toBe(true);
    }
  });

  it("rejects bad check digits, lengths and junk", () => {
    expect(isValidIban("CH9300762011623852958")).toBe(false);
    expect(isValidIban("CH9300762011623852957".slice(0, -1))).toBe(false);
    expect(isValidIban("DE8937040044053201300")).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban("1234")).toBe(false);
    expect(isValidIban("CH93-0076-2011-6238-5295-7")).toBe(false);
  });

  it("formats in groups of four", () => {
    expect(formatIban("CH9300762011623852957")).toBe(
      "CH93 0076 2011 6238 5295 7",
    );
  });

  it("masks keeping country, check digits and last four", () => {
    expect(maskIban("CH9300762011623852957")).toBe(
      "CH93 •••• •••• •••• •295 7",
    );
    expect(maskIban("CH93")).toBe("CH93");
  });

  it("detects QR-IBANs by IID range", () => {
    expect(isQrIban("CH4431999123000889012")).toBe(true);
    expect(isQrIban("CH44 3199 9123 0008 8901 2")).toBe(true);
    expect(isQrIban("CH9300762011623852957")).toBe(false);
    expect(isQrIban("CH5604835012345678009")).toBe(false);
    expect(isQrIban("DE89370400440532013000")).toBe(false);
  });
});
