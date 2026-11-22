import { error, fail, redirect } from "@sveltejs/kit";
import { SCOPE_CONFLICTS } from "$lib/api-tokens";
import { adminConfirmMode } from "$lib/server/auth/admin-confirm";
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
import { LedgerError } from "$lib/server/ledger/errors";
import {
  approveAuthorization,
  beginAuthorization,
  denyAuthorization,
  loadPendingConsent,
} from "$lib/server/oauth/authorize";
import {
  consentAccessSchema,
  needsConfirmation,
} from "$lib/server/oauth/consent";
import { CONNECTION_SCOPE_GROUPS } from "$lib/server/oauth/scopes";
import { AUTHORIZE_PATH } from "$lib/server/oauth/urls";
import type { Actions, PageServerLoad } from "./$types";

const EXPIRED =
  "This sign-in request has expired. Start again from the application.";

/**
 * The authorization endpoint and its consent page (`/oauth/authorize`), for a
 * signed-in owner (the hook sends everyone else to the login page and back).
 *
 * A request with OAuth parameters is validated and stored once, then the
 * browser is sent to the same page with only the id of the stored request:
 * `?consent=<id>`. The page and both actions work on that stored request, never
 * on parameters the form carries.
 */
export const load: PageServerLoad = async ({ locals, url, request }) => {
  const user = requireUser(locals);
  if (url.searchParams.has("client_id")) {
    const begun = await beginAuthorization(user.id, url.searchParams, url);
    if (begun.kind === "invalid") error(400, begun.message);
    // The location is the client's own registered redirect URI (matched against its
    // registration), with the error added: the one external redirect this app makes.
    if (begun.kind === "redirect") {
      redirect(303, begun.location, { external: true });
    }
    redirect(303, `${AUTHORIZE_PATH}?consent=${encodeURIComponent(begun.id)}`);
  }
  const consent = await loadPendingConsent(
    user.id,
    url.searchParams.get("consent") ?? "",
  );
  if (!consent) {
    // A plain form post (no JavaScript) runs the action first and then this
    // load, by which time the answered request is spent: the page then shows the
    // action's "continue" link, not an error.
    if (request.method === "POST") {
      return {
        consent: null,
        scopeGroups: CONNECTION_SCOPE_GROUPS,
        scopeConflicts: SCOPE_CONFLICTS,
        accounts: [],
        categories: [],
        confirmMode: "password" as const,
      };
    }
    error(400, EXPIRED);
  }
  const [categories, accounts] = await Promise.all([
    listCategories(user.id),
    listAccountNames(user.id),
  ]);
  return {
    consent,
    scopeGroups: CONNECTION_SCOPE_GROUPS,
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

const FIELDS = ["expires", "restrict", "restrictAccounts"] as const;

export const actions: Actions = {
  approve: async ({ locals, request, url }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, FIELDS);
    const consentId = String(form.get("consent") ?? "");
    const pending = await loadPendingConsent(user.id, consentId);
    if (!pending) {
      return fail(400, { errors: { form: [EXPIRED] }, values });
    }

    const expires = expiresSchema.safeParse(form.get("expires") ?? "");
    const restrict = form.get("restrict") === "on";
    const restrictAccounts = form.get("restrictAccounts") === "on";
    const input = consentAccessSchema.safeParse({
      scopes: form.getAll("scope"),
      categoryIds: restrict
        ? form.getAll("categoryId").filter((v) => typeof v === "string")
        : null,
      accountIds: restrictAccounts
        ? form.getAll("accountId").filter((v) => typeof v === "string")
        : null,
      expiresAt: expires.success ? expires.data : null,
    });
    const errors: Record<string, string[]> = input.success
      ? {}
      : accessErrors(input.error);
    if (!expires.success) errors.expires = [expires.error.issues[0]!.message];

    // Only a grant that changes data needs the password: reading is what an
    // assistant is for, writing is what the owner should have to mean.
    const writes = input.success && needsConfirmation(input.data.scopes);
    const confirm = writes ? parseForm(confirmSchema, form) : null;
    if (confirm && !confirm.ok) Object.assign(errors, confirm.errors);
    if (!input.success || Object.keys(errors).length > 0) {
      return fail(400, { errors, values });
    }
    if (confirm?.ok) {
      // Cheap checks first: a refused form must not spend a TOTP step or recovery code.
      const refused = await confirmationFailure(
        user.id,
        locals.session?.id,
        { password: confirm.data.adminPassword, code: confirm.data.adminCode },
        values,
      );
      if (refused) return refused;
    }

    try {
      const { redirectTo } = await approveAuthorization(
        user.id,
        consentId,
        input.data,
        url,
      );
      return {
        approved: true as const,
        redirectTo,
        clientName: pending.clientName,
      };
    } catch (err) {
      if (err instanceof LedgerError) {
        return fail(400, {
          errors: { [err.field ?? "form"]: [err.message] },
          values,
        });
      }
      throw err;
    }
  },

  deny: async ({ locals, request, url }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const consentId = String(form.get("consent") ?? "");
    const pending = await loadPendingConsent(user.id, consentId);
    try {
      const { redirectTo } = await denyAuthorization(user.id, consentId, url);
      return {
        denied: true as const,
        redirectTo,
        clientName: pending?.clientName ?? "the application",
      };
    } catch (err) {
      if (err instanceof LedgerError) {
        return fail(400, {
          errors: { form: [err.message] },
          values: {} as Record<string, string>,
        });
      }
      throw err;
    }
  },
};
