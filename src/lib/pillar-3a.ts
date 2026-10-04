import { formatAmount, minor, type Minor } from "$lib/money";
import type {
  Pillar3aContributionKind,
  Pillar3aDeduction,
} from "$lib/pillar-3a-types";

/**
 * Pillar 3a rules (BVV 3), all in CHF minor units.
 *
 * - The yearly limit is per person across all 3a accounts: the small
 *   deduction (with a pension fund) is 8% of the BVG upper limit, the large
 *   one (no pension fund) is 20% of net earned income, capped at 40% of it.
 * - A contribution counts for the year it is credited.
 * - Buy-ins (since 2026) close gaps of years from 2025 on, at most ten years
 *   back, each gap year only once, up to the small deduction of the buy-in
 *   year, and not once an age benefit has been drawn.
 */

export const PILLAR_3A_CURRENCY = "CHF";
export const FIRST_BUY_IN_GAP_YEAR = 2025;
export const MAX_BUY_IN_YEARS_BACK = 10;
/** A payment booked after this day of December may be credited in January. */
export const LATE_DECEMBER_DAY = 20;

export interface Pillar3aLimits {
  bvgUpperLimit: Minor;
  small: Minor;
  largeCap: Minor;
}

export const PILLAR_3A_LIMITS: Readonly<Record<number, Pillar3aLimits>> = {
  2024: {
    bvgUpperLimit: minor(8_820_000),
    small: minor(705_600),
    largeCap: minor(3_528_000),
  },
  2025: {
    bvgUpperLimit: minor(9_072_000),
    small: minor(725_800),
    largeCap: minor(3_628_800),
  },
  2026: {
    bvgUpperLimit: minor(9_072_000),
    small: minor(725_800),
    largeCap: minor(3_628_800),
  },
};

export interface YearLimits extends Pillar3aLimits {
  year: number;
  /** The year is not in the table; the nearest known year is used instead. */
  unconfirmed: boolean;
}

const KNOWN_YEARS = Object.keys(PILLAR_3A_LIMITS)
  .map(Number)
  .sort((a, b) => a - b);

/** Limits of a year; years outside the table use the nearest known year and are `unconfirmed`. */
export function limitFor(year: number): YearLimits {
  const known = PILLAR_3A_LIMITS[year];
  if (known) return { year, ...known, unconfirmed: false };
  const nearest =
    year > KNOWN_YEARS[KNOWN_YEARS.length - 1]!
      ? KNOWN_YEARS[KNOWN_YEARS.length - 1]!
      : KNOWN_YEARS[0]!;
  return { year, ...PILLAR_3A_LIMITS[nearest]!, unconfirmed: true };
}

export interface Pillar3aYearSetting {
  year: number;
  deduction: Pillar3aDeduction;
  earnedIncome: Minor | null;
}

export interface ResolvedSetting {
  deduction: Pillar3aDeduction;
  earnedIncome: Minor | null;
  /** Taken from an earlier year because this year has no setting of its own. */
  inherited: boolean;
}

/** The setting of a year, else the latest earlier year's, else the small deduction. */
export function settingFor(
  year: number,
  settings: readonly Pillar3aYearSetting[],
): ResolvedSetting {
  let best: Pillar3aYearSetting | null = null;
  for (const s of settings) {
    if (s.year === year) {
      return {
        deduction: s.deduction,
        earnedIncome: s.earnedIncome,
        inherited: false,
      };
    }
    if (s.year < year && (best === null || s.year > best.year)) best = s;
  }
  return best
    ? {
        deduction: best.deduction,
        earnedIncome: best.earnedIncome,
        inherited: true,
      }
    : { deduction: "small", earnedIncome: null, inherited: true };
}

export interface YearLimit {
  limit: Minor;
  /** The limit is an estimate: unknown year in the table, or a large deduction without income. */
  unconfirmed: boolean;
}

/**
 * The yearly limit for a setting. "none" is 0, "small" the small deduction,
 * "large" `min(20% of earned income, cap)`; without income it is the cap.
 */
export function yearLimit(
  year: number,
  setting: { deduction: Pillar3aDeduction; earnedIncome?: Minor | null },
): YearLimit {
  const limits = limitFor(year);
  if (setting.deduction === "none")
    return { limit: minor(0), unconfirmed: false };
  if (setting.deduction === "small") {
    return { limit: limits.small, unconfirmed: limits.unconfirmed };
  }
  const income = setting.earnedIncome ?? null;
  if (income === null) {
    return { limit: limits.largeCap, unconfirmed: true };
  }
  return {
    limit: minor(
      Math.min(Math.round(Math.max(0, income) / 5), limits.largeCap),
    ),
    unconfirmed: limits.unconfirmed,
  };
}

export interface ContributionFact {
  /** Tax year: the year of the credit date. */
  year: number;
  kind: Pillar3aContributionKind;
  amount: Minor;
}

export interface BuyInYearFact {
  year: number;
  /** The contribution that closes the year. */
  buyInId: string;
}

export interface GapYear {
  year: number;
  limit: Minor;
  unconfirmed: boolean;
  ordinary: Minor;
  /** `max(0, limit - ordinary)`. */
  gap: Minor;
  closedBy: string | null;
}

/** One entry per year from 2025 up to the year before `today`. */
export function gapsFor(input: {
  buyInYears: readonly BuyInYearFact[];
  contributions: readonly ContributionFact[];
  settings: readonly Pillar3aYearSetting[];
  today: string;
}): GapYear[] {
  const lastYear = Number(input.today.slice(0, 4)) - 1;
  const closed = new Map(input.buyInYears.map((b) => [b.year, b.buyInId]));
  const out: GapYear[] = [];
  for (let year = FIRST_BUY_IN_GAP_YEAR; year <= lastYear; year++) {
    const { limit, unconfirmed } = yearLimit(
      year,
      settingFor(year, input.settings),
    );
    const ordinary = input.contributions
      .filter((c) => c.year === year && c.kind === "ordinary")
      .reduce((sum, c) => sum + c.amount, 0);
    out.push({
      year,
      limit,
      unconfirmed,
      ordinary: minor(ordinary),
      gap: minor(Math.max(0, limit - ordinary)),
      closedBy: closed.get(year) ?? null,
    });
  }
  return out;
}

export interface BuyInCheck {
  errors: string[];
  warnings: string[];
}

/**
 * Checks a buy-in. `year` is the buy-in's tax year; `gaps` come from
 * `gapsFor`. `contributionId` is the buy-in being edited, whose own gap years
 * do not count as closed. `ordinaryPaid` and `ordinaryLimit` are those of
 * the buy-in year (it may be the running year, which `gaps` does not cover).
 */
export function validateBuyIn(input: {
  year: number;
  amount: Minor;
  gapYears: readonly number[];
  gaps: readonly GapYear[];
  ageBenefitDrawn: boolean;
  ordinaryPaid: Minor;
  ordinaryLimit: Minor;
  contributionId?: string | null;
}): BuyInCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { year } = input;

  if (input.ageBenefitDrawn) {
    errors.push("A buy-in is not possible once an age benefit has been drawn.");
  }
  if (input.amount <= 0) errors.push("The buy-in amount must be positive.");
  if (input.gapYears.length === 0) {
    errors.push("Choose the gap years this buy-in closes.");
  }
  const unique = new Set(input.gapYears);
  if (unique.size !== input.gapYears.length) {
    errors.push("Each gap year can only be chosen once.");
  }

  let gapSum = 0;
  for (const gapYear of unique) {
    if (gapYear < FIRST_BUY_IN_GAP_YEAR) {
      errors.push(
        `${gapYear} cannot be bought in: only gaps from ${FIRST_BUY_IN_GAP_YEAR} on qualify.`,
      );
      continue;
    }
    if (gapYear >= year) {
      errors.push(`${gapYear} is not before the buy-in year ${year}.`);
      continue;
    }
    if (gapYear < year - MAX_BUY_IN_YEARS_BACK) {
      errors.push(
        `${gapYear} is more than ${MAX_BUY_IN_YEARS_BACK} years before the buy-in year.`,
      );
      continue;
    }
    const gap = input.gaps.find((g) => g.year === gapYear);
    if (!gap) {
      errors.push(`${gapYear} is not available for a buy-in.`);
      continue;
    }
    if (
      gap.closedBy !== null &&
      gap.closedBy !== (input.contributionId ?? null)
    ) {
      errors.push(`${gapYear} has already been closed by a buy-in.`);
      continue;
    }
    if (gap.gap <= 0) {
      errors.push(`${gapYear} has no gap to close.`);
      continue;
    }
    gapSum += gap.gap;
  }

  const small = limitFor(year).small;
  if (input.amount > small) {
    errors.push(
      `A buy-in can be at most the small deduction of ${year} (${formatAmount(small, "CHF")}).`,
    );
  }
  if (errors.length === 0 && input.amount > gapSum) {
    errors.push(
      `The buy-in exceeds the chosen gaps (${formatAmount(minor(gapSum), "CHF")}).`,
    );
  }

  if (input.ordinaryPaid < input.ordinaryLimit) {
    warnings.push(
      `The ordinary contribution of ${year} is not fully paid yet. It must be paid in full for the buy-in to count.`,
    );
  }
  return { errors, warnings };
}

/** A payment booked after 20 December may only be credited in January. */
export function lateDecemberWarning(date: string): string | null {
  const m = /^\d{4}-12-(\d{2})$/.exec(date);
  if (!m || Number(m[1]) <= LATE_DECEMBER_DAY) return null;
  return "Booked after 20 December: the provider may credit it in January, which changes the tax year.";
}

/** Tax year of a contribution: the year of its effective (credit) date. */
export function taxYearOf(date: string): number {
  return Number(date.slice(0, 4));
}
