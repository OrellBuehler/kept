import { describe, expect, it } from "vitest";
import { minor } from "./money";
import {
  fixed,
  fixedFromProviderNumber,
  fixedToInput,
  formatFixed,
  invertFixed,
  parseFixed,
  proportionOf,
  valueOf,
} from "./quantity";

describe("parseFixed", () => {
  it("parses integers and decimals", () => {
    expect(parseFixed("12")).toBe(1_200_000_000);
    expect(parseFixed("12.5")).toBe(1_250_000_000);
    expect(parseFixed("0.00000001")).toBe(1);
    expect(parseFixed("-1.5")).toBe(-150_000_000);
    expect(parseFixed("+2")).toBe(200_000_000);
  });

  it("accepts the separators parseAmount accepts", () => {
    expect(parseFixed("1'234.5")).toBe(parseFixed("1234.5"));
    expect(parseFixed("1 234,5")).toBe(parseFixed("1234.5"));
    expect(parseFixed("1’234,5")).toBe(parseFixed("1234.5"));
    expect(parseFixed("  3 ")).toBe(300_000_000);
  });

  it("is exact where floats are not", () => {
    expect(parseFixed("0.1") + parseFixed("0.2")).toBe(parseFixed("0.3"));
    expect(parseFixed("1.00000005")).toBe(100_000_005);
  });

  it("returns 0, never -0, for a signed zero", () => {
    expect(Object.is(parseFixed("-0"), 0)).toBe(true);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "1.2.3", "1e3", "--1", "1,", ".5"]) {
      expect(() => parseFixed(bad)).toThrow(SyntaxError);
    }
  });

  it("rejects more than 8 decimals", () => {
    expect(() => parseFixed("0.000000001")).toThrow(RangeError);
  });

  it("rejects values beyond the safe range", () => {
    expect(parseFixed("90071992.54740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseFixed("90071992.54740992")).toThrow(RangeError);
    expect(() => parseFixed("99999999999999999999")).toThrow(RangeError);
  });
});

describe("fixedFromProviderNumber", () => {
  it("rounds to 8 decimals", () => {
    expect(fixedFromProviderNumber(123.456)).toBe(parseFixed("123.456"));
    expect(fixedFromProviderNumber(0.1 + 0.2)).toBe(parseFixed("0.3"));
    expect(fixedFromProviderNumber(1 / 3)).toBe(33_333_333);
    expect(fixedFromProviderNumber(1e-9)).toBe(0);
  });

  it("rejects non-finite and out-of-range numbers", () => {
    expect(() => fixedFromProviderNumber(NaN)).toThrow(RangeError);
    expect(() => fixedFromProviderNumber(Infinity)).toThrow(RangeError);
    expect(() => fixedFromProviderNumber(1e12)).toThrow(RangeError);
  });
});

describe("fixedToInput and formatFixed", () => {
  it("round-trips with parseFixed", () => {
    for (const s of [
      "0",
      "1",
      "1.5",
      "0.00000001",
      "-2.25",
      "1234567.12345678",
    ]) {
      expect(fixedToInput(parseFixed(s))).toBe(s);
    }
  });

  it("formats with grouping and trimmed decimals", () => {
    expect(formatFixed(parseFixed("1234.5"))).toBe("1,234.5");
    expect(formatFixed(parseFixed("1234"))).toBe("1,234");
    expect(formatFixed(parseFixed("1234"), "en", 2)).toBe("1,234.00");
    expect(formatFixed(parseFixed("0.12345678"))).toBe("0.12345678");
    expect(formatFixed(parseFixed("-0.5"))).toBe("-0.5");
  });

  it("uses the locale's decimal separator", () => {
    expect(formatFixed(parseFixed("2.5"), "de-CH")).toBe("2.5");
    expect(formatFixed(parseFixed("2.5"), "de-DE")).toBe("2,5");
  });
});

describe("invertFixed", () => {
  it("inverts and rounds half away from zero", () => {
    expect(invertFixed(parseFixed("2"))).toBe(parseFixed("0.5"));
    expect(invertFixed(parseFixed("3"))).toBe(33_333_333);
    expect(invertFixed(parseFixed("-4"))).toBe(parseFixed("-0.25"));
    expect(() => invertFixed(fixed(0))).toThrow(RangeError);
  });
});

describe("valueOf", () => {
  const one = parseFixed("1");

  it("multiplies quantity, price and fx into minor units", () => {
    expect(valueOf(parseFixed("10"), parseFixed("12.34"), one, "CHF")).toBe(
      12340,
    );
    expect(
      valueOf(parseFixed("2.5"), parseFixed("100"), parseFixed("0.9"), "CHF"),
    ).toBe(22500);
  });

  it("rounds half away from zero", () => {
    expect(valueOf(parseFixed("1"), parseFixed("0.005"), one, "CHF")).toBe(1);
    expect(valueOf(parseFixed("1"), parseFixed("0.004"), one, "CHF")).toBe(0);
    expect(valueOf(parseFixed("-1"), parseFixed("0.005"), one, "CHF")).toBe(-1);
    expect(valueOf(parseFixed("1"), parseFixed("-0.005"), one, "CHF")).toBe(-1);
    expect(
      Object.is(valueOf(parseFixed("-1"), parseFixed("0.001"), one, "CHF"), 0),
    ).toBe(true);
  });

  it("uses the currency exponent", () => {
    expect(valueOf(parseFixed("3"), parseFixed("100"), one, "JPY")).toBe(300);
    expect(valueOf(parseFixed("3"), parseFixed("1.5"), one, "KWD")).toBe(4500);
  });

  it("stays exact beyond double precision", () => {
    expect(
      valueOf(
        parseFixed("12345678.12345678"),
        parseFixed("9999.99999999"),
        one,
        "CHF",
      ),
    ).toBe(12345678123444);
  });

  it("divides by the rate for an inverse pair without double rounding", () => {
    expect(
      valueOf(
        parseFixed("1"),
        parseFixed("100"),
        parseFixed("0.8"),
        "CHF",
        true,
      ),
    ).toBe(12500);
    const jpyChf = parseFixed("0.0057");
    expect(
      valueOf(parseFixed("100"), parseFixed("1000"), jpyChf, "JPY", true),
    ).toBe(17543860);
    expect(() => valueOf(one, one, fixed(0), "CHF", true)).toThrow(RangeError);
  });

  it("throws when the result is not a safe integer", () => {
    expect(() =>
      valueOf(
        parseFixed("90000000"),
        parseFixed("90000000"),
        parseFixed("90000000"),
        "CHF",
      ),
    ).toThrow(RangeError);
  });
});

describe("proportionOf", () => {
  it("scales an amount by part / whole", () => {
    expect(proportionOf(minor(10000), parseFixed("1"), parseFixed("4"))).toBe(
      2500,
    );
    expect(proportionOf(minor(100), parseFixed("1"), parseFixed("3"))).toBe(33);
    expect(proportionOf(minor(100), parseFixed("2"), parseFixed("3"))).toBe(67);
    expect(proportionOf(minor(-100), parseFixed("2"), parseFixed("3"))).toBe(
      -67,
    );
    expect(() => proportionOf(minor(1), parseFixed("1"), fixed(0))).toThrow(
      RangeError,
    );
  });
});
