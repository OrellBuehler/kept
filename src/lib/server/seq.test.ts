import { afterEach, describe, expect, it, vi } from "vitest";
import { nextSeq } from "./seq";

describe("nextSeq", () => {
  afterEach(() => vi.useRealTimers());

  it("is strictly increasing within one millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const values = Array.from({ length: 2000 }, () => nextSeq());
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("stays increasing when the clock moves backwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    const a = nextSeq();
    vi.setSystemTime(new Date("2030-06-01T00:00:00.000Z"));
    expect(nextSeq()).toBeGreaterThan(a);
  });

  it("is a safe integer ahead of any rowid", () => {
    const value = nextSeq();
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(1_000_000_000_000);
  });
});
