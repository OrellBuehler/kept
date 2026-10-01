import { z } from "zod";
import {
  AMOUNT_SIGNS,
  CATEGORY_ICONS,
  CATEGORY_KINDS,
  COLOR_PATTERN,
} from "$lib/category-types";
import {
  currencySchema,
  idSchema,
  optionalOf,
  optionalText,
  parseMoneyInput,
} from "$lib/server/ledger/schemas";

export { idFormSchema, idSchema } from "$lib/server/ledger/schemas";

export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Enter a month as YYYY-MM.");

export const categoryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(60, "Name must be at most 60 characters."),
  kind: z.enum(CATEGORY_KINDS, "Choose income or expense."),
  parentId: optionalOf(idSchema),
  color: optionalOf(
    z.string().trim().regex(COLOR_PATTERN, "Enter a colour as #rrggbb."),
  ),
  icon: optionalOf(z.enum(CATEGORY_ICONS, "Choose an icon from the list.")),
});
export type CategoryInput = z.output<typeof categoryInputSchema>;

export const ruleInputSchema = z
  .object({
    categoryId: idSchema,
    priority: z
      .string()
      .trim()
      .transform((v) => (v === "" ? "100" : v))
      .pipe(
        z
          .string()
          .regex(/^\d{1,4}$/, "Enter a priority between 0 and 9999.")
          .transform(Number),
      ),
    counterpartyContains: optionalText(100, "Counterparty text"),
    descriptionContains: optionalText(100, "Description text"),
    counterpartyIban: optionalText(34, "IBAN"),
    amountSign: optionalOf(z.enum(AMOUNT_SIGNS, "Choose income or expense.")),
  })
  .refine(
    (r) =>
      r.counterpartyContains !== null ||
      r.descriptionContains !== null ||
      r.counterpartyIban !== null ||
      r.amountSign !== null,
    { message: "Set at least one condition.", path: ["form"] },
  );
export type RuleInput = z.output<typeof ruleInputSchema>;

export const assignCategorySchema = z.object({
  transactionId: idSchema,
  categoryId: optionalOf(idSchema),
});

export const budgetInputSchema = z
  .object({
    categoryId: idSchema,
    currency: currencySchema,
    amount: z.string(),
  })
  .transform((v, ctx) => {
    const r = parseMoneyInput(v.amount, v.currency);
    const message = !r.ok
      ? r.message
      : r.value <= 0
        ? "The budget must be greater than zero."
        : null;
    if (message !== null || !r.ok) {
      ctx.issues.push({
        code: "custom",
        message: message ?? "Enter a valid amount.",
        input: v.amount,
        path: ["amount"],
      });
      return z.NEVER;
    }
    return { categoryId: v.categoryId, currency: v.currency, amount: r.value };
  });
export type BudgetInput = z.output<typeof budgetInputSchema>;
