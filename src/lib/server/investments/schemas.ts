import { z } from "zod";
import { SECURITY_KINDS, TRADE_SIDES } from "$lib/investment-types";
import { minor } from "$lib/money";
import { parseFixed } from "$lib/quantity";
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
            /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/,
            "An ISIN has 12 characters: 2 letters, 9 letters or digits and a check digit.",
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

/** `fees` and `amount` are in the account's currency; `price` in the security's. */
export function tradeInputSchema(accountCurrency: string) {
  return z.object({
    securityId: idSchema,
    date: dateSchema,
    side: z.enum(TRADE_SIDES, "Choose buy or sell."),
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
    note: optionalText(1000, "Note"),
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
