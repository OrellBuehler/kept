import { z } from "zod";
import { type Minor } from "$lib/money";
import {
  currencySchema,
  dateSchema,
  idSchema,
  optionalOf,
  optionalText,
  parseMoneyInput,
} from "$lib/server/ledger/schemas";
import { normalizeReference } from "$lib/references";

export const MIN_TAX_YEAR = 1900;
export const MAX_TAX_YEAR = 2200;
/** Largest accepted amount in minor units (keeps sums well inside safe integers). */
export const MAX_TAX_AMOUNT = 1_000_000_000_000;

export const yearSchema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, "Enter a four-digit year.")
  .transform(Number)
  .refine(
    (y) => y >= MIN_TAX_YEAR && y <= MAX_TAX_YEAR,
    `Enter a year between ${MIN_TAX_YEAR} and ${MAX_TAX_YEAR}.`,
  );

/** Route param: a year, or null when it is not one. */
export function parseYearParam(value: string): number | null {
  const r = yearSchema.safeParse(value);
  return r.success ? r.data : null;
}

export interface TaxYearInput {
  year: number;
  authority: string | null;
  currency: string;
  /** Minor units, >= 0; null while there is no assessment yet. */
  assessedTotal: Minor | null;
  notes: string | null;
}

export const TAX_YEAR_FORM_FIELDS = [
  "year",
  "authority",
  "currency",
  "assessedTotal",
  "notes",
] as const;

export const taxYearInputSchema = z
  .object({
    year: yearSchema,
    authority: optionalText(140, "Tax authority"),
    currency: currencySchema,
    assessedTotal: z.string().optional(),
    notes: optionalText(2000, "Notes"),
  })
  .transform((v, ctx): TaxYearInput => {
    let assessedTotal: Minor | null = null;
    const raw = v.assessedTotal?.trim() ?? "";
    if (raw !== "") {
      const r = parseMoneyInput(raw, v.currency);
      if (!r.ok) {
        ctx.issues.push({
          code: "custom",
          message: r.message,
          input: raw,
          path: ["assessedTotal"],
        });
      } else if (r.value < 0 || r.value > MAX_TAX_AMOUNT) {
        ctx.issues.push({
          code: "custom",
          message: "Enter the assessed total as zero or more.",
          input: raw,
          path: ["assessedTotal"],
        });
      } else assessedTotal = r.value;
    }
    return {
      year: v.year,
      authority: v.authority,
      currency: v.currency,
      assessedTotal,
      notes: v.notes,
    };
  });

export interface TaxCreditInput {
  bookingDate: string;
  /** Signed: positive is a payment the office counted, negative a repayment. */
  amount: Minor;
  reference: string | null;
  description: string | null;
}

export const TAX_CREDIT_FORM_FIELDS = [
  "bookingDate",
  "amount",
  "reference",
  "description",
] as const;

export function taxCreditInputSchema(currency: string) {
  return z
    .object({
      bookingDate: dateSchema,
      amount: z.string().trim().min(1, "Enter an amount."),
      reference: optionalText(35, "Reference"),
      description: optionalText(500, "Description"),
    })
    .transform((v, ctx): TaxCreditInput => {
      let amount = 0 as Minor;
      const r = parseMoneyInput(v.amount, currency);
      if (!r.ok) {
        ctx.issues.push({
          code: "custom",
          message: r.message,
          input: v.amount,
          path: ["amount"],
        });
      } else if (r.value === 0 || Math.abs(r.value) > MAX_TAX_AMOUNT) {
        ctx.issues.push({
          code: "custom",
          message: "Enter a non-zero amount.",
          input: v.amount,
          path: ["amount"],
        });
      } else amount = r.value;
      return {
        bookingDate: v.bookingDate,
        amount,
        reference:
          v.reference === null ? null : normalizeReference(v.reference),
        description: v.description,
      };
    });
}

export const taxCreditIdSchema = z.object({ creditId: idSchema });

export const taxTagSchema = z.object({
  transactionId: idSchema,
  taxYear: optionalOf(yearSchema),
});

export const deductionYearTagSchema = z.object({
  transactionId: idSchema,
  deductionYear: optionalOf(yearSchema),
});
