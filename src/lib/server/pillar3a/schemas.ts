import { z } from "zod";
import {
  PILLAR_3A_CONTRIBUTION_KINDS,
  PILLAR_3A_DEDUCTIONS,
  PORTFOLIO_CLOSE_REASONS,
} from "$lib/pillar-3a-types";
import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
import { isValidQrr, isValidScor, normalizeReference } from "$lib/references";
import type { ParsedForm } from "$lib/server/forms";
import {
  amountField,
  dateSchema,
  idSchema,
  optionalDate,
  optionalOf,
  optionalText,
  parseMoneyInput,
} from "$lib/server/ledger/schemas";
import type { Minor } from "$lib/money";

const referenceSchema = z
  .string()
  .transform(normalizeReference)
  .refine(
    (v) => isValidQrr(v) || isValidScor(v),
    "Enter a valid QR reference (27 digits) or creditor reference (RF...).",
  );

const sortOrderSchema = optionalOf(
  z
    .string()
    .trim()
    .regex(/^-?\d{1,6}$/, "Enter a whole number.")
    .transform(Number),
);

// --- portfolios -----------------------------------------------------------

export const portfolioInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be at most 80 characters."),
  number: optionalText(60, "Number"),
  strategy: optionalText(80, "Strategy"),
  depositReference: optionalOf(referenceSchema),
  openedOn: optionalDate,
  sortOrder: sortOrderSchema,
});
export type PortfolioInput = z.output<typeof portfolioInputSchema>;

export const portfolioCloseSchema = z.object({
  closedOn: dateSchema,
  closeReason: z.enum(PORTFOLIO_CLOSE_REASONS, "Choose a reason."),
});
export type PortfolioCloseInput = z.output<typeof portfolioCloseSchema>;

// --- values ---------------------------------------------------------------

export interface PortfolioValueEntry {
  portfolioId: string;
  amount: Minor;
}

export const portfolioValueNoteSchema = optionalText(1000, "Note");

export interface PortfolioValuesInput {
  date: string;
  note: string | null;
  entries: PortfolioValueEntry[];
}

/** Form field that carries the value of one portfolio: `value:<portfolioId>`. */
export const PORTFOLIO_VALUE_FIELD_PREFIX = "value:";

/**
 * Parses the "update values" form: `date`, an optional `note` and one
 * `value:<portfolioId>` amount per portfolio. Blank amounts are skipped; at
 * least one amount is required. Amounts must not be negative.
 */
export function parsePortfolioValuesForm(
  form: FormData,
): ParsedForm<PortfolioValuesInput> {
  const errors: Record<string, string[]> = {};
  const date = dateSchema.safeParse(form.get("date") ?? "");
  if (!date.success) errors.date = [date.error.issues[0]!.message];
  const note = portfolioValueNoteSchema.safeParse(form.get("note") ?? "");
  if (!note.success) errors.note = [note.error.issues[0]!.message];

  const entries: PortfolioValueEntry[] = [];
  for (const [key, raw] of form.entries()) {
    if (
      typeof raw !== "string" ||
      !key.startsWith(PORTFOLIO_VALUE_FIELD_PREFIX)
    ) {
      continue;
    }
    if (raw.trim() === "") continue;
    const portfolioId = key.slice(PORTFOLIO_VALUE_FIELD_PREFIX.length);
    const parsed = parseMoneyInput(raw, PILLAR_3A_CURRENCY);
    if (!parsed.ok) {
      errors[key] = [parsed.message];
    } else if (parsed.value < 0) {
      errors[key] = ["The value must not be negative."];
    } else {
      entries.push({ portfolioId, amount: parsed.value });
    }
  }
  if (entries.length === 0 && Object.keys(errors).length === 0) {
    errors.form = ["Enter at least one value."];
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      date: date.data!,
      note: note.data ?? null,
      entries,
    },
  };
}

// --- contributions --------------------------------------------------------

/** "2025, 2026" or "2025 2026" (as submitted by a hidden field) into years. */
const gapYearsSchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const parts = (v ?? "").split(/[\s,;]+/).filter((p) => p !== "");
    const years: number[] = [];
    for (const p of parts) {
      if (!/^\d{4}$/.test(p)) {
        ctx.issues.push({
          code: "custom",
          message: "Gap years must be four-digit years.",
          input: v,
        });
        return z.NEVER;
      }
      years.push(Number(p));
    }
    return years;
  });

const contributionDetails = {
  date: dateSchema,
  kind: z.enum(PILLAR_3A_CONTRIBUTION_KINDS, "Choose a type."),
  gapYears: gapYearsSchema,
  note: optionalText(1000, "Note"),
};

/** Edits of a detected payment: its amount always comes from the transaction. */
export const contributionDetailsSchema = z.object(contributionDetails);
export type ContributionDetailsInput = z.output<
  typeof contributionDetailsSchema
>;

export const manualContributionSchema = z.object({
  ...contributionDetails,
  portfolioId: idSchema,
  amount: amountField(PILLAR_3A_CURRENCY, { nonZero: true }).refine(
    (v) => v > 0,
    "The amount must be positive.",
  ),
});
export type ManualContributionInput = z.output<typeof manualContributionSchema>;

// --- years ----------------------------------------------------------------

export const yearSettingSchema = z
  .object({
    year: z.coerce.number().int().min(1990).max(2200),
    deduction: z.enum(PILLAR_3A_DEDUCTIONS, "Choose a deduction."),
    earnedIncome: optionalOf(
      amountField(PILLAR_3A_CURRENCY).refine(
        (v) => v >= 0,
        "Income must not be negative.",
      ),
    ),
  })
  .transform((v) => ({
    year: v.year,
    deduction: v.deduction,
    earnedIncome: v.deduction === "large" ? v.earnedIncome : null,
  }));
export type YearSettingInput = z.output<typeof yearSettingSchema>;
