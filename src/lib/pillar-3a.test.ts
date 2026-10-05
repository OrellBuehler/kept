import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  gapsFor,
  lateDecemberWarning,
  limitFor,
  settingFor,
  taxYearOf,
  validateBuyIn,
  yearLimit,
  type GapYear,
} from "./pillar-3a";

describe("limitFor", () => {
  it("returns the table values per year", () => {
    expect(limitFor(2024)).toEqual({
      year: 2024,
      bvgUpperLimit: 8_820_000,
      small: 705_600,
      largeCap: 3_528_000,
      unconfirmed: false,
    });
    expect(limitFor(2025).small).toBe(725_800);
    expect(limitFor(2026).largeCap).toBe(3_628_800);
    expect(limitFor(2026).bvgUpperLimit).toBe(9_072_000);
  });

  it("falls back to the latest known year and flags it", () => {
    const l = limitFor(2031);
    expect(l.unconfirmed).toBe(true);
    expect(l.small).toBe(725_800);
    expect(l.year).toBe(2031);
  });

  it("uses the earliest known year before the table", () => {
    const l = limitFor(2020);
    expect(l.unconfirmed).toBe(true);
    expect(l.small).toBe(705_600);
  });
});

describe("settingFor", () => {
  const settings = [
    { year: 2025, deduction: "large" as const, earnedIncome: minor(5_000_000) },
    { year: 2027, deduction: "none" as const, earnedIncome: null },
  ];
  it("prefers the exact year", () => {
    expect(settingFor(2027, settings)).toEqual({
      deduction: "none",
      earnedIncome: null,
      inherited: false,
    });
  });
  it("inherits from the latest earlier year", () => {
    expect(settingFor(2026, settings)).toEqual({
      deduction: "large",
      earnedIncome: 5_000_000,
      inherited: true,
    });
  });
  it("defaults to the small deduction", () => {
    expect(settingFor(2024, settings)).toEqual({
      deduction: "small",
      earnedIncome: null,
      inherited: true,
    });
    expect(settingFor(2026, [])).toMatchObject({ deduction: "small" });
  });
});

describe("yearLimit", () => {
  it("none is zero", () => {
    expect(yearLimit(2025, { deduction: "none" })).toEqual({
      limit: 0,
      unconfirmed: false,
    });
  });
  it("small is the small deduction", () => {
    expect(yearLimit(2026, { deduction: "small" })).toEqual({
      limit: 725_800,
      unconfirmed: false,
    });
    expect(yearLimit(2040, { deduction: "small" }).unconfirmed).toBe(true);
  });
  it("large is 20% of income below the cap", () => {
    expect(
      yearLimit(2025, { deduction: "large", earnedIncome: minor(5_000_001) }),
    ).toEqual({ limit: 1_000_000, unconfirmed: false });
  });
  it("large is capped", () => {
    expect(
      yearLimit(2025, { deduction: "large", earnedIncome: minor(50_000_000) }),
    ).toEqual({ limit: 3_628_800, unconfirmed: false });
  });
  it("large without income is the cap and unconfirmed", () => {
    expect(yearLimit(2025, { deduction: "large" })).toEqual({
      limit: 3_628_800,
      unconfirmed: true,
    });
    expect(
      yearLimit(2025, { deduction: "large", earnedIncome: null }).unconfirmed,
    ).toBe(true);
  });
});

describe("gapsFor", () => {
  const today = "2027-03-10";
  it("lists 2025 up to the year before today", () => {
    const gaps = gapsFor({
      buyInYears: [],
      contributions: [],
      settings: [],
      today,
    });
    expect(gaps.map((g) => g.year)).toEqual([2025, 2026]);
    expect(gaps[0]).toMatchObject({
      limit: 725_800,
      ordinary: 0,
      gap: 725_800,
    });
  });

  it("is empty in 2025 and 2026 has only 2025", () => {
    const none = { buyInYears: [], contributions: [], settings: [] };
    expect(gapsFor({ ...none, today: "2025-06-01" })).toEqual([]);
    expect(
      gapsFor({ ...none, today: "2026-06-01" }).map((g) => g.year),
    ).toEqual([2025]);
  });

  it("subtracts ordinary contributions only and marks closed years", () => {
    const gaps = gapsFor({
      buyInYears: [{ year: 2025, buyInId: "b1" }],
      contributions: [
        { year: 2025, kind: "ordinary", amount: minor(500_000) },
        { year: 2025, kind: "buy_in", amount: minor(100_000) },
        { year: 2026, kind: "ordinary", amount: minor(900_000) },
      ],
      settings: [],
      today,
    });
    expect(gaps[0]).toMatchObject({
      ordinary: 500_000,
      gap: 225_800,
      closedBy: "b1",
    });
    expect(gaps[1]).toMatchObject({
      ordinary: 900_000,
      gap: 0,
      closedBy: null,
    });
  });

  it("honours deduction settings", () => {
    const gaps = gapsFor({
      buyInYears: [],
      contributions: [],
      settings: [{ year: 2025, deduction: "none", earnedIncome: null }],
      today,
    });
    expect(gaps.map((g) => g.gap)).toEqual([0, 0]);
  });
});

describe("validateBuyIn", () => {
  const gap = (year: number, over: Partial<GapYear> = {}): GapYear => ({
    year,
    limit: minor(725_800),
    unconfirmed: false,
    ordinary: minor(0),
    gap: minor(725_800),
    closedBy: null,
    ...over,
  });
  const base = {
    year: 2027,
    amount: minor(400_000),
    gapYears: [2025],
    gaps: [gap(2025), gap(2026)],
    ageBenefitDrawn: false,
    ordinaryPaid: minor(725_800),
    ordinaryLimit: minor(725_800),
    today: "2027-03-01",
  };

  it("accepts a valid buy-in without warnings", () => {
    expect(validateBuyIn(base)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects a gap year before 2025", () => {
    const r = validateBuyIn({ ...base, gapYears: [2024] });
    expect(r.errors.join(" ")).toMatch(/2024/);
  });

  it("rejects a gap year more than 10 years back", () => {
    const r = validateBuyIn({ ...base, year: 2036, gapYears: [2025] });
    expect(r.errors.join(" ")).toMatch(/10 years/);
    expect(
      validateBuyIn({ ...base, year: 2035, gapYears: [2025] }).errors,
    ).toEqual([]);
  });

  it("rejects a gap year not before the buy-in year", () => {
    const r = validateBuyIn({ ...base, year: 2026, gapYears: [2026] });
    expect(r.errors.join(" ")).toMatch(/not before/);
  });

  it("rejects an unknown gap year", () => {
    const r = validateBuyIn({ ...base, gapYears: [2026], gaps: [gap(2025)] });
    expect(r.errors.join(" ")).toMatch(/not available/);
  });

  it("rejects an already closed gap year, but not by itself", () => {
    const gaps = [gap(2025, { closedBy: "b1" }), gap(2026)];
    expect(validateBuyIn({ ...base, gaps }).errors.join(" ")).toMatch(
      /already been closed/,
    );
    expect(
      validateBuyIn({ ...base, gaps, contributionId: "b1" }).errors,
    ).toEqual([]);
  });

  it("rejects a year without a gap", () => {
    const gaps = [gap(2025, { gap: minor(0), ordinary: minor(725_800) })];
    expect(validateBuyIn({ ...base, gaps }).errors.join(" ")).toMatch(/no gap/);
  });

  it("rejects an amount above the small limit of the buy-in year", () => {
    const r = validateBuyIn({
      ...base,
      amount: minor(725_801),
      gapYears: [2025, 2026],
    });
    expect(r.errors.join(" ")).toMatch(/small deduction of 2027/);
  });

  it("rejects an amount above the sum of the chosen gaps", () => {
    const gaps = [gap(2025, { gap: minor(100_000) }), gap(2026)];
    const r = validateBuyIn({ ...base, gaps, amount: minor(100_001) });
    expect(r.errors.join(" ")).toMatch(/exceeds the chosen gaps/);
  });

  it("rejects once an age benefit was drawn", () => {
    const r = validateBuyIn({ ...base, ageBenefitDrawn: true });
    expect(r.errors.join(" ")).toMatch(/age benefit/);
  });

  it("rejects empty, duplicate and non-positive input", () => {
    expect(validateBuyIn({ ...base, gapYears: [] }).errors.length).toBe(1);
    expect(
      validateBuyIn({ ...base, gapYears: [2025, 2025] }).errors.join(" "),
    ).toMatch(/only be chosen once/);
    expect(
      validateBuyIn({ ...base, amount: minor(0) }).errors.join(" "),
    ).toMatch(/positive/);
  });

  it("warns, but does not fail, when the ordinary contribution of the running year is unpaid", () => {
    const r = validateBuyIn({ ...base, ordinaryPaid: minor(100_000) });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/not fully paid/);
  });

  it("fails when the buy-in year is over and its ordinary contribution is short", () => {
    const r = validateBuyIn({
      ...base,
      ordinaryPaid: minor(100_000),
      today: "2028-01-02",
    });
    expect(r.errors.join(" ")).toMatch(/not paid in full/);
    expect(r.warnings).toEqual([]);
    expect(validateBuyIn({ ...base, today: "2028-01-02" }).errors).toEqual([]);
  });

  it("caps the total of all buy-ins of the buy-in year at the small deduction", () => {
    const gaps = [gap(2025), gap(2026)];
    const first = validateBuyIn({
      ...base,
      gaps,
      gapYears: [2025],
      amount: minor(725_800),
    });
    expect(first.errors).toEqual([]);
    const second = validateBuyIn({
      ...base,
      gaps,
      gapYears: [2026],
      amount: minor(725_800),
      otherBuyInsInYear: minor(725_800),
    });
    expect(second.errors.join(" ")).toMatch(/small deduction of 2027/);
    expect(
      validateBuyIn({
        ...base,
        gaps,
        gapYears: [2026],
        amount: minor(100_000),
        otherBuyInsInYear: minor(625_800),
      }).errors,
    ).toEqual([]);
    expect(
      validateBuyIn({
        ...base,
        gaps,
        gapYears: [2026],
        amount: minor(100_001),
        otherBuyInsInYear: minor(625_800),
      }).errors.join(" "),
    ).toMatch(/small deduction of 2027/);
  });

  it("applies the yearly cap to large-deduction gap years too", () => {
    const big = (year: number) =>
      gap(year, { limit: minor(3_628_800), gap: minor(3_628_800) });
    const r = validateBuyIn({
      ...base,
      gaps: [big(2025), big(2026)],
      gapYears: [2025, 2026],
      amount: minor(1_000_000),
    });
    expect(r.errors.join(" ")).toMatch(/small deduction of 2027/);
  });

  it("does not warn when the year has no limit", () => {
    const r = validateBuyIn({
      ...base,
      ordinaryPaid: minor(0),
      ordinaryLimit: minor(0),
    });
    expect(r.warnings).toEqual([]);
  });
});

describe("lateDecemberWarning", () => {
  it("warns after 20 December only", () => {
    expect(lateDecemberWarning("2025-12-20")).toBeNull();
    expect(lateDecemberWarning("2025-12-21")).toMatch(/January/);
    expect(lateDecemberWarning("2025-12-31")).toMatch(/January/);
    expect(lateDecemberWarning("2025-11-30")).toBeNull();
    expect(lateDecemberWarning("2025-01-25")).toBeNull();
  });
});

describe("taxYearOf", () => {
  it("is the year of the date", () => {
    expect(taxYearOf("2026-01-02")).toBe(2026);
  });
});
