import { fail } from "@sveltejs/kit";
import { z } from "zod";
import { API_SCOPES, API_SCOPE_GROUPS, SCOPE_CONFLICTS } from "$lib/api-tokens";
import { adminConfirmMode } from "$lib/server/auth/admin-confirm";
import {
  createApiToken,
  createApiTokenSchema,
  listApiTokens,
  revokeApiToken,
} from "$lib/server/auth/api-tokens";
import { requireUser } from "$lib/server/auth/guards";
import {
  accessErrors,
  confirmationFailure,
  confirmSchema,
  expiresSchema,
} from "$lib/server/auth/token-form";
import { listCategories } from "$lib/server/categories";
import { parseForm, safeValues } from "$lib/server/forms";
import { listAccountNames } from "$lib/server/ledger/accounts";
import { ledgerFailure } from "$lib/server/ledger/http";
import { idFormSchema } from "$lib/server/ledger/schemas";
import {
  listConnections,
  renameConnection,
  revokeConnection,
} from "$lib/server/oauth/connections";
import type { Actions, PageServerLoad } from "./$types";

const FIELDS = ["name", "expires", "restrict", "restrictAccounts"] as const;

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const [tokens, connections, categories, accounts] = await Promise.all([
    listApiTokens(user.id),
    listConnections(user.id),
    listCategories(user.id),
    listAccountNames(user.id),
  ]);
  return {
    tokens,
    /** Apps connected through sign-in (OAuth), newest first. */
    connections,
    scopes: API_SCOPES,
    scopeGroups: API_SCOPE_GROUPS,
    /** Scopes that cannot be combined with a restriction to categories or accounts, and why. */
    scopeConflicts: SCOPE_CONFLICTS,
    accounts,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
    })),
    confirmMode: await adminConfirmMode(user.id),
  };
};

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
    const restrictAccounts = form.get("restrictAccounts") === "on";
    const accountIds = form
      .getAll("accountId")
      .filter((v) => typeof v === "string");
    const input = createApiTokenSchema.safeParse({
      name: form.get("name") ?? "",
      scopes: form.getAll("scope"),
      categoryIds: restrict ? categoryIds : null,
      accountIds: restrictAccounts ? accountIds : null,
      expiresAt: expires.success ? expires.data : null,
    });

    const errors: Record<string, string[]> = input.success
      ? {}
      : accessErrors(input.error);
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

  revokeConnection: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(
      idFormSchema("connectionId"),
      await request.formData(),
    );
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await revokeConnection(user.id, parsed.data.connectionId);
      return { revokedConnection: true as const };
    } catch (err) {
      return ledgerFailure("revokeConnection", err);
    }
  },

  renameConnection: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const parsed = parseForm(
      idFormSchema("connectionId").extend({ name: z.string().max(200) }),
      form,
    );
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await renameConnection(
        user.id,
        parsed.data.connectionId,
        parsed.data.name,
      );
      return { renamedConnection: true as const };
    } catch (err) {
      return ledgerFailure("renameConnection", err);
    }
  },
};
