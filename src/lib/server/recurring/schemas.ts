import { z } from "zod";
import { CADENCES } from "$lib/recurring-types";
import { parseMoneyInput } from "$lib/server/ledger/schemas";

export { idFormSchema, idSchema } from "$lib/server/ledger/schemas";

export const seriesEditSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(100, "Name must be at most 100 characters."),
  cadence: z.enum(CADENCES, "Choose how often it repeats."),
  /** Positive text; the series keeps its direction (payment or income). */
  amount: z.string(),
});
export type SeriesEditInput = z.output<typeof seriesEditSchema>;

/** Parses the edited amount in the series' currency; positive, non-zero. */
export function parseEditedAmount(text: string, currency: string) {
  const r = parseMoneyInput(text.replace(/^[+-]/, ""), currency);
  if (!r.ok) return r;
  if (r.value === 0)
    return { ok: false as const, message: "Amount must not be zero." };
  return r;
}
