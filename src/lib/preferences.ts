import { z } from "zod";
import { COMMON_CURRENCIES } from "$lib/account-types";

export const IBAN_DISPLAY = ["full", "masked", "hidden"] as const;
export type IbanDisplay = (typeof IBAN_DISPLAY)[number];

export const LOCALES = ["en-GB", "de-CH", "de-DE", "fr-CH", "en-US"] as const;
export type AppLocale = (typeof LOCALES)[number];

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface Preferences {
  ibanDisplay: IbanDisplay;
  blurAmounts: boolean;
  locale: AppLocale;
  defaultCurrency: (typeof COMMON_CURRENCIES)[number];
  pageSize: PageSize;
}

export const DEFAULT_PREFERENCES: Preferences = {
  ibanDisplay: "full",
  blurAmounts: false,
  locale: "en-GB",
  defaultCurrency: "CHF",
  pageSize: 50,
};

const checkbox = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "on" || v === "true");

export const preferencesSchema = z.object({
  ibanDisplay: z.enum(IBAN_DISPLAY, "Choose how IBANs are shown."),
  blurAmounts: checkbox.default(false),
  locale: z.enum(LOCALES, "Choose a format."),
  defaultCurrency: z.enum(COMMON_CURRENCIES, "Choose a currency."),
  pageSize: z.coerce
    .number()
    .pipe(
      z.union(
        PAGE_SIZES.map((n) => z.literal(n)) as [
          z.ZodLiteral<25>,
          z.ZodLiteral<50>,
          z.ZodLiteral<100>,
          z.ZodLiteral<200>,
        ],
        "Choose a page size.",
      ),
    ),
});
export type PreferencesInput = z.output<typeof preferencesSchema>;
