import { z } from "zod";
import { currencyExponent } from "$lib/money";

/**
 * Minor units as a plain decimal string in the currency's own precision:
 * `-1250` CHF is "-12.50", `500` JPY is "500". Never goes through a float.
 */
export function decimal(amount: number, currency: string): string {
  const exp = currencyExponent(currency);
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(amount)).padStart(exp + 1, "0");
  return exp === 0
    ? `${sign}${digits}`
    : `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

export const decimalOrNull = (
  amount: number | null,
  currency: string,
): string | null => (amount === null ? null : decimal(amount, currency));

/** `YYYY-MM-DD` and a real calendar day. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, "Not a real date.");

export const MCP_DEFAULT_LIMIT = 25;
export const MCP_MAX_LIMIT = 100;

/** `limit` and `cursor`, the same on every list tool. */
export const pagingInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(
      `Page size, 1 to ${MCP_MAX_LIMIT} (default ${MCP_DEFAULT_LIMIT}).`,
    ),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe(
      "The nextCursor of the previous page. Opaque: pass it back unchanged.",
    ),
};

export const idInput = (what: string) =>
  z.string().min(1).max(64).describe(`The id of the ${what}.`);
