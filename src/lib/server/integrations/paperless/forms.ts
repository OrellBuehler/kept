import { z } from "zod";
import { BILL_STATUSES } from "$lib/bill-types";
import type { PaperlessFieldMapping } from "$lib/server/db";

const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true" || v === "1");

export const saveFormSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .min(1, "Enter the address of your Paperless server."),
  token: z.string().optional(),
  allowInsecureTls: checkbox,
});

const positiveId = z
  .string()
  .trim()
  .regex(/^\d{1,12}$/, "Enter a number.")
  .transform(Number)
  .refine((n) => n > 0, "Enter a number.");

export const sourceFormSchema = z.object({
  kind: z.enum(["tag", "saved_view"], "Choose a tag or a saved view."),
  id: positiveId,
});

const optionalFieldId = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  positiveId.optional(),
);

const statusValueShape = Object.fromEntries(
  BILL_STATUSES.map((s) => [
    `statusValue_${s}`,
    z.string().trim().max(128, "At most 128 characters.").optional(),
  ]),
);

export const mappingFormSchema = z
  .object({
    // Without an explicit intent an empty post (e.g. sent before the form was ready) must not wipe the mapping.
    intent: z.enum(["save", "clear"], "Choose save or clear."),
    amount: optionalFieldId,
    dueDate: optionalFieldId,
    reference: optionalFieldId,
    status: optionalFieldId,
    ...statusValueShape,
  })
  .transform((v, ctx): PaperlessFieldMapping => {
    if (v.intent === "clear") {
      return {
        amount: null,
        dueDate: null,
        reference: null,
        status: null,
        statusValues: {},
      };
    }
    const ids = [v.amount, v.dueDate, v.reference, v.status].filter(
      (x): x is number => x !== undefined,
    );
    if (new Set(ids).size !== ids.length) {
      ctx.issues.push({
        code: "custom",
        message: "Each Paperless field can be used for one Kept field only.",
        input: v,
        path: ["form"],
      });
    }
    const statusValues: Partial<Record<string, string>> = {};
    for (const s of BILL_STATUSES) {
      const value = (v as Record<string, unknown>)[`statusValue_${s}`];
      if (typeof value === "string" && value !== "") statusValues[s] = value;
    }
    if (ids.length === 0 && Object.keys(statusValues).length === 0) {
      ctx.issues.push({
        code: "custom",
        message: "Choose at least one field, or use Clear mapping.",
        input: v,
        path: ["form"],
      });
    }
    return {
      amount: v.amount ?? null,
      dueDate: v.dueDate ?? null,
      reference: v.reference ?? null,
      status: v.status ?? null,
      statusValues,
    };
  });

export const toggleFormSchema = z.object({
  enabled: z
    .enum(["true", "false"], "Choose on or off.")
    .transform((v) => v === "true"),
});
