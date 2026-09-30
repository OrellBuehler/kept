import { z } from "zod";

export const DELIMITERS = [",", ";", "\t", "|", "auto"] as const;
export const ENCODINGS = [
  "auto",
  "utf-8",
  "utf-16le",
  "windows-1252",
  "iso-8859-1",
] as const;
export const DATE_FORMATS = [
  "YYYY-MM-DD",
  "DD.MM.YYYY",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD.MM.YY",
  "YYYYMMDD",
] as const;

/**
 * A column is addressed by its header name (trimmed, case-insensitive) or by
 * its 0-based index. With `headerRow: 0` (no header line) only indexes work;
 * numeric strings such as "3" are accepted as indexes for convenience.
 */
const columnRef = z.union([z.string().min(1), z.number().int().min(0)]);
export type ColumnRef = z.infer<typeof columnRef>;

const columnRefList = z
  .union([columnRef, z.array(columnRef).min(1)])
  .transform((v): ColumnRef[] => (Array.isArray(v) ? v : [v]));

const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter ISO 4217 code")
  .transform((v) => v.toUpperCase());

const columns = z.object({
  bookingDate: columnRef,
  valueDate: columnRef.optional(),
  amount: columnRef.optional(),
  credit: columnRef.optional(),
  debit: columnRef.optional(),
  indicator: columnRef.optional(),
  currency: columnRef.optional(),
  originalAmount: columnRef.optional(),
  originalCurrency: columnRef.optional(),
  counterpartyName: columnRef.optional(),
  counterpartyIban: columnRef.optional(),
  description: columnRefList.optional(),
  reference: columnRef.optional(),
  externalId: columnRef.optional(),
  balance: columnRef.optional(),
});

export const csvMappingProfileSchema = z
  .object({
    delimiter: z.enum(DELIMITERS).default("auto"),
    encoding: z.enum(ENCODINGS).default("auto"),
    /** 1-based line of the header row; 0 means the file has no header. Lines above it are ignored. */
    headerRow: z.number().int().min(0).default(1),
    /** Number of trailing non-blank rows to ignore (e.g. totals lines). */
    skipFooterRows: z.number().int().min(0).default(0),
    dateFormat: z.enum(DATE_FORMATS).default("YYYY-MM-DD"),
    /**
     * Two-digit years (DD.MM.YY): yy < pivot is 20yy, yy >= pivot is 19yy.
     * The default 70 maps 00-69 to 2000-2069 and 70-99 to 1970-1999.
     */
    twoDigitYearPivot: z.number().int().min(0).max(100).default(70),
    decimalSeparator: z.enum([".", ","]).default("."),
    /** Grouping character inside amounts; omit or "" when amounts are not grouped. */
    thousandsSeparator: z.enum(["'", ",", ".", " ", ""]).default(""),
    amountMode: z.enum(["single", "single_with_indicator", "split"]),
    /** Flip the sign of every amount (exports where debits are positive). */
    invertSign: z.boolean().default(false),
    /** Indicator values (case-insensitive) that mark a credit / a debit. */
    indicatorCreditValues: z
      .array(z.string().min(1))
      .default(["CRDT", "Credit", "CR", "C"]),
    indicatorDebitValues: z
      .array(z.string().min(1))
      .default(["DBIT", "Debit", "DR", "D"]),
    /** Fixed currency, used when there is no currency column or the cell is empty. */
    defaultCurrency: currencyCode.optional(),
    columns,
  })
  .superRefine((p, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });

    if (p.decimalSeparator === p.thousandsSeparator) {
      issue("Thousands separator must differ from the decimal separator", [
        "thousandsSeparator",
      ]);
    }

    const c = p.columns;
    if (p.amountMode === "single" && c.amount === undefined) {
      issue("amountMode 'single' needs columns.amount", ["columns", "amount"]);
    }
    if (p.amountMode === "single_with_indicator") {
      if (c.amount === undefined) {
        issue("amountMode 'single_with_indicator' needs columns.amount", [
          "columns",
          "amount",
        ]);
      }
      if (c.indicator === undefined) {
        issue("amountMode 'single_with_indicator' needs columns.indicator", [
          "columns",
          "indicator",
        ]);
      }
    }
    if (
      p.amountMode === "split" &&
      c.credit === undefined &&
      c.debit === undefined
    ) {
      issue("amountMode 'split' needs columns.credit and/or columns.debit", [
        "columns",
        "credit",
      ]);
    }
    if (c.currency === undefined && p.defaultCurrency === undefined) {
      issue("Either columns.currency or defaultCurrency is required", [
        "defaultCurrency",
      ]);
    }
    if (
      (c.originalAmount === undefined) !==
      (c.originalCurrency === undefined)
    ) {
      issue("originalAmount and originalCurrency must be mapped together", [
        "columns",
        "originalAmount",
      ]);
    }

    if (p.headerRow === 0) {
      for (const [key, value] of Object.entries(c)) {
        const refs = Array.isArray(value) ? value : [value];
        for (const ref of refs) {
          if (typeof ref === "string" && !/^\d+$/.test(ref)) {
            issue(
              `Column "${ref}" is addressed by name but headerRow is 0; use a 0-based index`,
              ["columns", key],
            );
          }
        }
      }
    }
  });

export type CsvMappingProfile = z.output<typeof csvMappingProfileSchema>;
export type CsvMappingProfileInput = z.input<typeof csvMappingProfileSchema>;

export function parseMappingProfile(input: unknown): CsvMappingProfile {
  return csvMappingProfileSchema.parse(input);
}
