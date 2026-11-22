import { fail } from "@sveltejs/kit";
import { z } from "zod";
import { confirmAdmin } from "./admin-confirm";
import { apiTokenConfirmLimiter, RateLimitedError } from "./rate-limit";
import { adminCodeSchema, adminPasswordSchema } from "./schemas";
import { AuthError } from "./types";

/**
 * Form handling shared by the two places an owner decides what a credential may
 * do: the API token form and the consent page of an OAuth connection.
 */

/** `YYYY-MM-DD` (valid through the end of that day, UTC), or empty for "never". */
export const expiresSchema = z
  .string()
  .trim()
  .max(10)
  .transform((v, ctx) => {
    if (v === "") return null;
    const at = /^\d{4}-\d{2}-\d{2}$/.test(v)
      ? new Date(`${v}T23:59:59.999Z`)
      : null;
    if (!at || Number.isNaN(at.getTime())) {
      ctx.addIssue({ code: "custom", message: "Enter a date." });
      return z.NEVER;
    }
    return at;
  });

/** The password (and code) fields of the confirmation. */
export const confirmSchema = z.object({
  adminPassword: adminPasswordSchema,
  adminCode: adminCodeSchema,
});

/** Failure to return when the password (and code) does not confirm the user, else null. */
export async function confirmationFailure(
  userId: string,
  sessionId: string | undefined,
  input: { password: string; code: string },
  values: Record<string, string>,
) {
  try {
    await confirmAdmin(userId, sessionId, input, apiTokenConfirmLimiter);
    return null;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return fail(429, { errors: { form: [err.message] }, values });
    }
    if (err instanceof AuthError) {
      if (err.code === "invalid_credentials") {
        return fail(400, {
          errors: { adminPassword: ["Your password is incorrect."] },
          values,
        });
      }
      if (err.code === "invalid_code") {
        return fail(400, {
          errors: { adminCode: ["That code is not valid."] },
          values,
        });
      }
      if (err.code === "passkey_required") {
        return fail(400, { errors: { form: [err.message] }, values });
      }
    }
    throw err;
  }
}

/** The form fields of a credential's access choice as zod issues keyed like the form. */
export function accessErrors(error: z.ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const flat = z.flattenError(error);
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (Array.isArray(messages) && messages.length > 0) {
      errors[field === "expiresAt" ? "expires" : field] = messages as string[];
    }
  }
  if (flat.formErrors.length > 0) errors.form = flat.formErrors;
  return errors;
}
