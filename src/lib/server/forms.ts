import { z } from "zod";

export type FormErrors = Record<string, string[]>;

export type ParsedForm<T> =
  { ok: true; data: T } | { ok: false; errors: FormErrors };

/** Flat string view of submitted form fields (files are ignored). */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Parse a form with Zod. Field errors are keyed by field name; errors that do
 * not belong to a field are under `form`.
 */
export function parseForm<S extends z.ZodType>(
  schema: S,
  form: FormData,
): ParsedForm<z.output<S>> {
  const result = schema.safeParse(formToObject(form));
  if (result.success) return { ok: true, data: result.data };
  const flat = z.flattenError(result.error);
  const errors: FormErrors = {};
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (Array.isArray(messages) && messages.length > 0) {
      errors[field] = messages as string[];
    }
  }
  if (flat.formErrors.length > 0) errors.form = flat.formErrors;
  return { ok: false, errors };
}

/** Echo back submitted values for re-rendering a form, minus secrets. */
export function safeValues(
  form: FormData,
  fields: readonly string[],
): Record<string, string> {
  const all = formToObject(form);
  const out: Record<string, string> = {};
  for (const f of fields) out[f] = all[f] ?? "";
  return out;
}
