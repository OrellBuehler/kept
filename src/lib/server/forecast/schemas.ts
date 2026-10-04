import { z } from "zod";
import {
  currencySchema,
  dateSchema,
  idSchema,
  optionalOf,
} from "$lib/server/ledger/schemas";

export { idFormSchema } from "$lib/server/ledger/schemas";

export const HORIZONS = [30, 60, 90] as const;
export type Horizon = (typeof HORIZONS)[number];

export function parseHorizon(value: string | null): Horizon {
  const n = Number(value);
  return (HORIZONS as readonly number[]).includes(n) ? (n as Horizon) : 30;
}

/**
 * Amounts stay text here: their number of decimals depends on the currency,
 * which is only known once the account is looked up (see planned.ts).
 */
export const plannedItemInputSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Description is required.")
    .max(80, "Description must be at most 80 characters."),
  date: dateSchema,
  direction: z.enum(["income", "expense"], "Choose income or expense."),
  amount: z.string().trim().min(1, "Enter an amount."),
  accountId: optionalOf(idSchema),
  /** Only used without an account; otherwise the account's currency wins. */
  currency: optionalOf(currencySchema),
});
export type PlannedItemInput = z.output<typeof plannedItemInputSchema>;

export const accountSettingsInputSchema = z.object({
  accountId: idSchema,
  threshold: z.string().trim().optional(),
  defaultPayment: z.string().optional(),
});
export type AccountSettingsInput = z.output<typeof accountSettingsInputSchema>;
