import { describe, expect, it } from "vitest";
import {
  formatReference,
  isValidQrr,
  isValidScor,
  normalizeReference,
} from "./references";

describe("references", () => {
  it("validates QRR check digit", () => {
    expect(isValidQrr("210000000003139471430009017")).toBe(true);
    expect(isValidQrr("21 00000 00003 13947 14300 09017")).toBe(true);
    expect(isValidQrr("000000000000000000000000000")).toBe(true);
    expect(isValidQrr("210000000003139471430009018")).toBe(false);
    expect(isValidQrr("21000000000313947143000901")).toBe(false);
    expect(isValidQrr("2100000000031394714300090170")).toBe(false);
    expect(isValidQrr("21000000000313947143000901A")).toBe(false);
  });

  it("validates SCOR references", () => {
    expect(isValidScor("RF18539007547034")).toBe(true);
    expect(isValidScor("rf18 5390 0754 7034")).toBe(true);
    expect(isValidScor("RF19539007547034")).toBe(false);
    expect(isValidScor("RF18")).toBe(false);
    expect(isValidScor("RF18539007547034".padEnd(30, "0"))).toBe(false);
    expect(isValidScor("XX" + "18539007547034")).toBe(false);
  });

  it("normalizes and formats", () => {
    expect(normalizeReference(" rf18 5390 ")).toBe("RF185390");
    expect(formatReference("210000000003139471430009017")).toBe(
      "21 00000 00003 13947 14300 09017",
    );
    expect(formatReference("RF18539007547034")).toBe("RF18 5390 0754 7034");
  });
});
