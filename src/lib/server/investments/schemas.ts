import { z } from "zod";
import { SECURITY_KINDS, type TradeSide } from "$lib/investment-types";
import { minor, type Minor } from "$lib/money";
import { fixed, parseFixed, scaleFixed, type Fixed8 } from "$lib/quantity";
import {
  amountField,
  currencySchema,
  dateSchema,
  idSchema,
  optionalOf,
  optionalText,
  parseMoneyInput,
} from "$lib/server/ledger/schemas";

function positiveFixedField(label: string) {
  return z.string().transform((v, ctx) => {
    try {
      const parsed = parseFixed(v);
      if (parsed <= 0) {
        ctx.issues.push({
          code: "custom",
          message: `${label} must be greater than zero.`,
          input: v,
        });
        return z.NEVER;
      }
      return parsed;
    } catch (err) {
      if (!(err instanceof SyntaxError || err instanceof RangeError)) throw err;
      ctx.issues.push({
        code: "custom",
        message: `Enter a valid ${label.toLowerCase()} with at most 8 decimals, e.g. 12.5.`,
        input: v,
      });
      return z.NEVER;
    }
  });
}

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Luhn check over the ISIN with letters expanded to 10..35. */
export function isValidIsin(isin: string): boolean {
  if (!ISIN_SHAPE.test(isin)) return false;
  const digits = [...isin]
    .map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join("");
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// --- securities -----------------------------------------------------------

export const securityInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(120, "Name must be at most 120 characters."),
  kind: z.enum(SECURITY_KINDS, "Choose a type."),
  isin: optionalOf(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(
        z
          .string()
          .regex(
            ISIN_SHAPE,
            "An ISIN has 12 characters: 2 letters, 9 letters or digits and a check digit.",
          )
          .refine(
            (v) => !ISIN_SHAPE.test(v) || isValidIsin(v),
            "This ISIN's check digit is wrong.",
          ),
      ),
  ),
  symbol: optionalOf(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(
        z
          .string()
          .regex(
            /^[A-Z0-9.^=_-]{1,24}$/,
            "Symbol may contain letters, digits and . ^ = _ - (up to 24 characters).",
          ),
      ),
  ),
  currency: currencySchema,
});
export type SecurityInput = z.output<typeof securityInputSchema>;

// --- trades ---------------------------------------------------------------

export interface TradeFields {
  securityId: string;
  date: string;
  note: string | null;
  side: TradeSide;
  quantity: Fixed8;
  price: Fixed8;
  fees: Minor;
  amount: Minor;
  /** Split only: the exact integer ratio; absent or null for a buy, a sell or a plain-ratio split. */
  splitNew?: number | null;
  splitOld?: number | null;
}

/** Largest number in a split ratio; keeps the ratio's Fixed8 approximation above zero. */
export const MAX_SPLIT_TERM = 1_000_000;

function splitTerm(
  raw: string | undefined,
  field: "splitNew" | "splitOld",
  label: string,
  ctx: z.RefinementCtx,
): number | null {
  const text = (raw ?? "").trim();
  if (
    !/^\d+$/.test(text) ||
    Number(text) < 1 ||
    Number(text) > MAX_SPLIT_TERM
  ) {
    ctx.issues.push({
      code: "custom",
      message: `Enter ${label} as a whole number from 1 to ${MAX_SPLIT_TERM.toLocaleString("en")}.`,
      input: raw,
      path: [field],
    });
    return null;
  }
  return Number(text);
}

/**
 * `fees` and `amount` are in the account's currency; `price` in the security's.
 * A split carries only its ratio: price, fees and amount are 0. The ratio is entered as
 * whole numbers `splitNew : splitOld` (2:1 split, 1:3 reverse split), stored exactly and
 * mirrored into `quantity` as a Fixed8 approximation. A bare `quantity` ratio is still
 * accepted and stored without the exact terms.
 */
export function tradeInputSchema(accountCurrency: string) {
  const common = {
    securityId: idSchema,
    date: dateSchema,
    note: optionalText(1000, "Note"),
  };
  const cash = z.object({
    ...common,
    side: z.enum(["buy", "sell"]),
    quantity: positiveFixedField("Quantity"),
    price: positiveFixedField("Price"),
    fees: z
      .string()
      .optional()
      .transform((v, ctx) => {
        const raw = v?.trim() ?? "";
        if (raw === "") return minor(0);
        const r = parseMoneyInput(raw, accountCurrency);
        if (!r.ok || r.value < 0) {
          ctx.issues.push({
            code: "custom",
            message: r.ok ? "Fees must not be negative." : r.message,
            input: raw,
          });
          return z.NEVER;
        }
        return r.value;
      }),
    amount: amountField(accountCurrency, { nonZero: true }).refine(
      (v) => v > 0,
      "Amount must be greater than zero.",
    ),
  });
  const split = z.object({
    ...common,
    side: z.literal("split"),
    splitNew: z.string().optional(),
    splitOld: z.string().optional(),
    quantity: z.string().optional(),
  });
  const ratio = positiveFixedField("Split ratio");
  return z
    .discriminatedUnion("side", [cash, split], {
      error: "Choose buy, sell or split.",
    })
    .transform((v, ctx): TradeFields => {
      if (v.side !== "split") {
        return { ...v, splitNew: null, splitOld: null };
      }
      const zero = { price: fixed(0), fees: minor(0), amount: minor(0) };
      const {
        splitNew: rawNew,
        splitOld: rawOld,
        quantity: rawQuantity,
        ...rest
      } = v;
      if ((rawNew ?? "").trim() !== "" || (rawOld ?? "").trim() !== "") {
        const splitNew = splitTerm(
          rawNew,
          "splitNew",
          "the new share count",
          ctx,
        );
        const splitOld = splitTerm(
          rawOld,
          "splitOld",
          "the old share count",
          ctx,
        );
        if (splitNew === null || splitOld === null) return z.NEVER;
        return {
          ...rest,
          ...zero,
          quantity: scaleFixed(fixed(100_000_000), splitNew, splitOld),
          splitNew,
          splitOld,
        };
      }
      const parsed = ratio.safeParse(rawQuantity ?? "");
      if (!parsed.success) {
        ctx.issues.push({
          code: "custom",
          message: "Enter the split as new : old, e.g. 2 : 1.",
          input: rawQuantity,
          path: ["splitNew"],
        });
        return z.NEVER;
      }
      return {
        ...rest,
        ...zero,
        quantity: parsed.data,
        splitNew: null,
        splitOld: null,
      };
    });
}
export type TradeInput = z.output<ReturnType<typeof tradeInputSchema>>;

// --- prices ---------------------------------------------------------------

export const priceInputSchema = z.object({
  date: dateSchema,
  price: positiveFixedField("Price"),
});
export type PriceInput = z.output<typeof priceInputSchema>;

// --- market data ----------------------------------------------------------

export const marketDataSettingsSchema = z.object({
  enabled: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});
export type MarketDataSettingsInput = z.output<typeof marketDataSettingsSchema>;
