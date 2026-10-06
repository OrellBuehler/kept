import { fail } from "@sveltejs/kit";
import { z } from "zod";
import { API_SCOPES } from "$lib/api-tokens";
import { confirmAdmin, adminConfirmMode } from "$lib/server/auth/admin-confirm";
import {
  createApiToken,
  createApiTokenSchema,
  listApiTokens,
  revokeApiToken,
} from "$lib/server/auth/api-tokens";
import { requireUser } from "$lib/server/auth/guards";
import {
  apiTokenConfirmLimiter,
  RateLimitedError,
} from "$lib/server/auth/rate-limit";
import { adminCodeSchema, adminPasswordSchema } from "$lib/server/auth/schemas";
import { AuthError } from "$lib/server/auth/types";
import { listCategories } from "$lib/server/categories";
import { parseForm, safeValues } from "$lib/server/forms";
import { ledgerFailure } from "$lib/server/ledger/http";
import { idFormSchema } from "$lib/server/ledger/schemas";
import type { Actions, PageServerLoad } from "./$types";

const FIELDS = ["name", "expires", "restrict"] as const;

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const [tokens, categories] = await Promise.all([
    listApiTokens(user.id),
    listCategories(user.id),
  ]);
  return {
    tokens,
    scopes: API_SCOPES,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
    })),
    confirmMode: await adminConfirmMode(user.id),
  };
};

const expiresSchema = z
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

const confirmSchema = z.object({
  adminPassword: adminPasswordSchema,
  adminCode: adminCodeSchema,
});

/** Failure to return when the password (and code) does not confirm the user, else null. */
async function confirmationFailure(
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

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, FIELDS);

    const confirm = parseForm(confirmSchema, form);
    const expires = expiresSchema.safeParse(form.get("expires") ?? "");
    const restrict = form.get("restrict") === "on";
    const categoryIds = form
      .getAll("categoryId")
      .filter((v) => typeof v === "string");
    const input = createApiTokenSchema.safeParse({
      name: form.get("name") ?? "",
      scopes: form.getAll("scope"),
      categoryIds: restrict ? categoryIds : null,
      expiresAt: expires.success ? expires.data : null,
    });

    const errors: Record<string, string[]> = {};
    if (!input.success) {
      const flat = z.flattenError(input.error);
      for (const [field, messages] of Object.entries(flat.fieldErrors)) {
        if (Array.isArray(messages) && messages.length > 0) {
          errors[field === "expiresAt" ? "expires" : field] =
            messages as string[];
        }
      }
      if (flat.formErrors.length > 0) errors.form = flat.formErrors;
    }
    if (!expires.success) errors.expires = [expires.error.issues[0]!.message];
    if (!confirm.ok) Object.assign(errors, confirm.errors);
    if (Object.keys(errors).length > 0 || !input.success || !confirm.ok) {
      return fail(400, { errors, values });
    }

    // Cheap checks first: a refused form must not spend a TOTP step or recovery code.
    const refused = await confirmationFailure(
      user.id,
      locals.session?.id,
      { password: confirm.data.adminPassword, code: confirm.data.adminCode },
      values,
    );
    if (refused) return refused;

    try {
      const { token, info } = await createApiToken(user.id, input.data);
      return { created: true as const, token, name: info.name };
    } catch (err) {
      return ledgerFailure("create", err, values);
    }
  },

  revoke: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(idFormSchema("tokenId"), await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await revokeApiToken(user.id, parsed.data.tokenId);
      return { revoked: true as const };
    } catch (err) {
      return ledgerFailure("revoke", err);
    }
  },
};
