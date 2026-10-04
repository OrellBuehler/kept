import { describe, expect, it } from "vitest";
import {
  formatShare,
  minor,
  parseShareBasis,
  parseSharePercent,
  shareOf,
  shareToInput,
} from "./money";

describe("shareOf", () => {
  it("returns the amount unchanged at 100%", () => {
    expect(shareOf(minor(12345), 10000)).toBe(12345);
    expect(shareOf(minor(-12345), 10000)).toBe(-12345);
    expect(shareOf(minor(0), 10000)).toBe(0);
  });

  it.each([
    [10000, 5000, 5000],
    [-10000, 5000, -5000],
    [10000, 7000, 7000],
    [10000, 3333, 3333],
    [0, 3333, 0],
    [12345, 1, 1],
  ])("scales %i at %i bp to %i", (amount, bps, expected) => {
    expect(shareOf(minor(amount), bps)).toBe(expected);
  });

  it("rounds half away from zero for odd minor units", () => {
    expect(shareOf(minor(5), 5000)).toBe(3);
    expect(shareOf(minor(-5), 5000)).toBe(-3);
    expect(shareOf(minor(1), 5000)).toBe(1);
    expect(shareOf(minor(-1), 5000)).toBe(-1);
    expect(shareOf(minor(3), 5000)).toBe(2);
    expect(shareOf(minor(-3), 5000)).toBe(-2);
    expect(shareOf(minor(101), 5000)).toBe(51);
    expect(shareOf(minor(-101), 5000)).toBe(-51);
  });

  it("rounds to the nearest unit otherwise", () => {
    expect(shareOf(minor(10), 3333)).toBe(3);
    expect(shareOf(minor(-10), 3333)).toBe(-3);
    expect(shareOf(minor(100), 6667)).toBe(67);
    expect(shareOf(minor(7), 7000)).toBe(5);
    expect(shareOf(minor(-7), 7000)).toBe(-5);
    expect(shareOf(minor(1), 4999)).toBe(0);
    expect(shareOf(minor(1), 5000)).toBe(1);
  });

  it("is odd: the share of a negative is the negated share of the positive", () => {
    for (const bps of [1, 2500, 3333, 5000, 6667, 7000, 9999]) {
      for (const n of [1, 2, 3, 5, 99, 101, 12345, 999999]) {
        expect(shareOf(minor(-n), bps)).toBe(-shareOf(minor(n), bps));
      }
    }
  });

  it("stays exact for amounts whose product exceeds 2^53", () => {
    expect(shareOf(minor(9_000_000_000_000_000), 5000)).toBe(
      4_500_000_000_000_000,
    );
    expect(shareOf(minor(-9_000_000_000_000_000), 3333)).toBe(
      -2_999_700_000_000_000,
    );
  });

  it("rejects invalid basis points", () => {
    expect(() => shareOf(minor(1), -1)).toThrow(RangeError);
    expect(() => shareOf(minor(1), 0.5)).toThrow(RangeError);
    expect(() => shareOf(minor(1), Number.NaN)).toThrow(RangeError);
  });
});

describe("share percentages", () => {
  it.each([
    ["50", 5000],
    ["100", 10000],
    ["70 %", 7000],
    ["33.33", 3333],
    ["33,3", 3330],
    ["0.01", 1],
    [" 12.5% ", 1250],
  ])("parses %j as %i", (input, bps) => {
    expect(parseSharePercent(input)).toBe(bps);
  });

  it.each([
    "",
    "abc",
    "-5",
    "1.234",
    "50.",
    "1e2",
    "101",
    "100.01",
    "0",
    "0.00",
  ])("rejects %j", (input) => {
    expect(() => parseSharePercent(input)).toThrow();
  });

  it("formats and round-trips", () => {
    expect(formatShare(5000)).toBe("50%");
    expect(formatShare(3333)).toBe("33.33%");
    expect(formatShare(1250)).toBe("12.5%");
    expect(shareToInput(10000)).toBe("100");
    for (const bps of [1, 1250, 3333, 5000, 10000]) {
      expect(parseSharePercent(shareToInput(bps))).toBe(bps);
    }
  });

  it("parses the basis with a fallback", () => {
    expect(parseShareBasis("share", "total")).toBe("share");
    expect(parseShareBasis("total", "share")).toBe("total");
    expect(parseShareBasis("bogus", "share")).toBe("share");
    expect(parseShareBasis(null, "total")).toBe("total");
  });
});
