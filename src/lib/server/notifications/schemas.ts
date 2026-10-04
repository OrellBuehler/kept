import { z } from "zod";
import { normalizeUrl } from "./channels/http";

const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true" || v === "1");

const intInRange = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, message)
    .transform(Number)
    .refine((n) => n >= min && n <= max, message);

export const settingsFormSchema = z.object({
  billDueEnabled: checkbox,
  billDueDays: intInRange(1, 60, "Enter 1 to 60 days."),
  billOverdueEnabled: checkbox,
  budgetEnabled: checkbox,
  budgetPercent: intInRange(1, 200, "Enter a percentage from 1 to 200."),
  staleImportEnabled: checkbox,
  staleImportDays: intInRange(1, 365, "Enter 1 to 365 days."),
});

const url = (message: string) =>
  z
    .string()
    .trim()
    .max(2048)
    .transform((v, ctx) => {
      const normalized = normalizeUrl(v);
      if (normalized === null) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return normalized;
    });

const optionalSecret = z
  .string()
  .max(512, "At most 512 characters.")
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

export const ntfyFormSchema = z.object({
  serverUrl: url(
    "Enter the address of your ntfy server, e.g. https://ntfy.sh.",
  ),
  topic: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, digits, - and _ (up to 64)."),
  token: optionalSecret,
});

export const webhookFormSchema = z.object({
  url: url("Enter an http or https address."),
  secret: optionalSecret,
});

export const emailFormSchema = z.object({
  to: z.string().trim().max(254).pipe(z.email("Enter an email address.")),
});

export const channelFormSchemas = {
  ntfy: ntfyFormSchema,
  webhook: webhookFormSchema,
  email: emailFormSchema,
} as const;

export const channelKindSchema = z.enum(
  ["ntfy", "webhook", "email"],
  "Unknown channel.",
);
