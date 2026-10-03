import { z } from "zod";
import { ACCOUNT_TYPES } from "$lib/ledger-types";
import {
  currencyExponent,
  FULL_SHARE_BPS,
  minor,
  parseAmount,
  parseSharePercent,
  type Minor,
} from "$lib/money";
import { isValidIban, normalizeIban } from "$lib/iban";

/** Blank or missing form fields become null; everything else goes through `schema`. */
export function optionalOf<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (v) =>
      v === undefined || (typeof v === "string" && v.trim() === "") ? null : v,
    schema.nullable(),
  ) as z.ZodType<z.output<S> | null>;
}

export const optionalText = (max: number, label: string) =>
  optionalOf(
    z.string().trim().max(max, `${label} must be at most ${max} characters.`),
  );

export function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

export const dateSchema = z
  .string()
  .trim()
  .refine(isRealDate, "Enter a date as YYYY-MM-DD.");
export const optionalDate = optionalOf(dateSchema);

export const currencySchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "Enter a 3-letter currency code."));

const ibanSchema = z
  .string()
  .transform(normalizeIban)
  .refine(isValidIban, "Enter a valid IBAN.");
export const optionalIban = optionalOf(ibanSchema);

export const idSchema = z.string().trim().min(1, "Required.");
export const idFormSchema = <K extends string>(field: K) =>
  z.object({ [field]: idSchema } as Record<K, typeof idSchema>);

type MoneyResult = { ok: true; value: Minor } | { ok: false; message: string };

export function parseMoneyInput(value: string, currency: string): MoneyResult {
  try {
    return { ok: true, value: parseAmount(value, currencyExponent(currency)) };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { ok: false, message: "Enter a valid amount, e.g. 12.50." };
    }
    if (err instanceof RangeError) {
      return {
        ok: false,
        message: "Amount has too many decimal places or is too large.",
      };
    }
    throw err;
  }
}

function amountField(currency: string, opts: { nonZero?: boolean } = {}) {
  return z.string().transform((v, ctx) => {
    const r = parseMoneyInput(v, currency);
    if (!r.ok) {
      ctx.issues.push({ code: "custom", message: r.message, input: v });
      return z.NEVER;
    }
    if (opts.nonZero && r.value === 0) {
      ctx.issues.push({
        code: "custom",
        message: "Amount must not be zero.",
        input: v,
      });
      return z.NEVER;
    }
    return r.value;
  });
}

// --- institutions ---------------------------------------------------------

export const institutionInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be at most 80 characters."),
  bic: optionalOf(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(
        z
          .string()
          .regex(
            /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
            "BIC must be 8 or 11 characters.",
          ),
      ),
  ),
  color: optionalOf(
    z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "Color must look like #1a2b3c.")
      .transform((v) => v.toLowerCase()),
  ),
});
export type InstitutionInput = z.output<typeof institutionInputSchema>;

// --- accounts -------------------------------------------------------------

export const accountInputSchema = z
  .object({
    institutionId: optionalOf(idSchema),
    name: z
      .string()
      .trim()
      .min(1, "Name is required.")
      .max(80, "Name must be at most 80 characters."),
    type: z.enum(ACCOUNT_TYPES, "Choose an account type."),
    currency: currencySchema,
    iban: optionalIban,
    openingBalance: z.string().optional(),
    openingDate: optionalDate,
    /** "My share" as a percentage; blank means 100. */
    share: z.string().optional(),
    sharedWith: optionalText(80, "Shared with"),
    sortOrder: optionalOf(
      z
        .string()
        .trim()
        .regex(/^-?\d{1,6}$/, "Enter a whole number.")
        .transform(Number),
    ),
  })
  .transform((v, ctx) => {
    const raw = v.openingBalance?.trim() ?? "";
    let openingBalance = minor(0);
    if (raw !== "") {
      const r = parseMoneyInput(raw, v.currency);
      if (!r.ok) {
        ctx.issues.push({
          code: "custom",
          message: r.message,
          input: raw,
          path: ["openingBalance"],
        });
        return z.NEVER;
      }
      openingBalance = r.value;
    }
    let shareBps = FULL_SHARE_BPS;
    const { share, ...rest } = v;
    const rawShare = share?.trim() ?? "";
    if (rawShare !== "") {
      try {
        shareBps = parseSharePercent(rawShare);
      } catch (err) {
        if (!(err instanceof SyntaxError || err instanceof RangeError)) {
          throw err;
        }
        ctx.issues.push({
          code: "custom",
          message: "Enter a share above 0 and up to 100, e.g. 50 or 33.33.",
          input: rawShare,
          path: ["share"],
        });
        return z.NEVER;
      }
    }
    return { ...rest, openingBalance, shareBps };
  });
export type AccountInput = z.output<typeof accountInputSchema>;

// --- transactions ---------------------------------------------------------

const transactionTextFields = {
  counterpartyName: optionalText(140, "Counterparty"),
  counterpartyIban: optionalIban,
  description: optionalText(500, "Description"),
  reference: optionalText(35, "Reference"),
  note: optionalText(1000, "Note"),
};

/** Manual transaction; the amount is in the account's currency. */
export function transactionInputSchema(currency: string) {
  return z.object({
    bookingDate: dateSchema,
    valueDate: optionalDate,
    amount: amountField(currency, { nonZero: true }),
    ...transactionTextFields,
  });
}
export type TransactionInput = z.output<
  ReturnType<typeof transactionInputSchema>
>;

/** Imported transactions can only have their note edited. */
export const transactionNoteSchema = z.object({
  note: transactionTextFields.note,
});
export type TransactionNoteInput = z.output<typeof transactionNoteSchema>;

// --- snapshots ------------------------------------------------------------

export function snapshotInputSchema(currency: string) {
  return z.object({
    date: dateSchema,
    amount: amountField(currency),
    note: optionalText(1000, "Note"),
  });
}
export type SnapshotInput = z.output<ReturnType<typeof snapshotInputSchema>>;

// --- list filters ---------------------------------------------------------

export interface TransactionFilters {
  from?: string;
  to?: string;
  q?: string;
  minAmount?: Minor;
  maxAmount?: Minor;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ParsedListQuery {
  filters: TransactionFilters;
  /** Raw values as typed, for re-filling the filter form. */
  raw: { from: string; to: string; q: string; min: string; max: string };
  /** Invalid filters are ignored and reported here, keyed by param name. */
  errors: Record<string, string[]>;
  page: number;
  pageSize: number;
}

export function parseListQuery(
  params: URLSearchParams,
  currency: string,
): ParsedListQuery {
  const get = (k: string) => params.get(k)?.trim() ?? "";
  const raw = {
    from: get("from"),
    to: get("to"),
    q: get("q"),
    min: get("min"),
    max: get("max"),
  };
  const filters: TransactionFilters = {};
  const errors: Record<string, string[]> = {};

  for (const key of ["from", "to"] as const) {
    if (raw[key] === "") continue;
    const r = dateSchema.safeParse(raw[key]);
    if (r.success) filters[key] = r.data;
    else errors[key] = [r.error.issues[0]!.message];
  }
  if (raw.q !== "") filters.q = raw.q.slice(0, 200);
  for (const [param, key] of [
    ["min", "minAmount"],
    ["max", "maxAmount"],
  ] as const) {
    if (raw[param] === "") continue;
    const r = parseMoneyInput(raw[param], currency);
    if (r.ok) filters[key] = r.value;
    else errors[param] = [r.message];
  }

  const int = (k: string, fallback: number) => {
    const v = get(k);
    return /^\d{1,6}$/.test(v) ? Number(v) : fallback;
  };
  const page = Math.max(1, int("page", 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, int("pageSize", DEFAULT_PAGE_SIZE)),
  );
  return { filters, raw, errors, page, pageSize };
}
