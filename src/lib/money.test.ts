import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  formatAmount,
  minor,
  parseAmount,
  toDecimalString,
} from "./money";

describe("toDecimalString", () => {
  it.each([
    [194975, 2, "1949.75"],
    [5, 2, "0.05"],
    [0, 2, "0.00"],
    [-1230, 2, "-12.30"],
    [1234, 0, "1234"],
    [1234567, 3, "1234.567"],
  ])("formats %d with %d decimals as %s", (value, decimals, expected) => {
    expect(toDecimalString(minor(value), decimals)).toBe(expected);
    expect(parseAmount(expected, decimals)).toBe(value);
  });
});

describe("parseAmount", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["-12.34", -1234],
    ["+5,05", 505],
    ["1'234.50", 123450],
    ["1 234,50", 123450],
  ])("parses %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it("rejects too many decimals", () => {
    expect(() => parseAmount("1.234")).toThrow(RangeError);
  });

  it("rejects garbage", () => {
    expect(() => parseAmount("12abc")).toThrow(SyntaxError);
  });
});

describe("minor", () => {
  it("rejects non-integers", () => {
    expect(() => minor(1.5)).toThrow(RangeError);
  });
});

describe("formatAmount", () => {
  it("formats minor units as currency", () => {
    expect(formatAmount(minor(123450), "EUR", "en")).toBe("€1,234.50");
  });
});

describe("currencyExponent", () => {
  it.each([
    ["CHF", 2],
    ["eur", 2],
    ["JPY", 0],
    ["KWD", 3],
  ])("%s has %i minor digits", (code, exp) => {
    expect(currencyExponent(code)).toBe(exp);
    expect(currencyExponent(code)).toBe(exp);
  });

  it("rejects malformed codes", () => {
    expect(() => currencyExponent("FRANC")).toThrow(RangeError);
  });
});

describe("formatAmount by currency exponent", () => {
  it("uses the currency's own minor unit", () => {
    const fmt = (v: number, c: string) =>
      formatAmount(minor(v), c).replace(/\u00a0/g, " ");
    expect(fmt(123450, "CHF")).toBe("CHF 1,234.50");
    expect(fmt(1234, "JPY")).toBe("¥1,234");
    expect(fmt(1234567, "KWD")).toBe("KWD 1,234.567");
  });
});
