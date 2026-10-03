import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import { createAccount, listAccounts } from "$lib/server/ledger/accounts";
import { ledgerFailure } from "$lib/server/ledger/http";
import {
  createInstitution,
  deleteInstitution,
  listInstitutions,
  updateInstitution,
} from "$lib/server/ledger/institutions";
import {
  accountInputSchema,
  idFormSchema,
  idSchema,
  institutionInputSchema,
} from "$lib/server/ledger/schemas";
import type { Actions, PageServerLoad } from "./$types";

const institutionFields = ["name", "bic", "color"] as const;
const accountFields = [
  "institutionId",
  "name",
  "type",
  "currency",
  "iban",
  "openingBalance",
  "openingDate",
  "share",
  "sharedWith",
  "sortOrder",
] as const;

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  return {
    institutions: listInstitutions(user.id),
    accounts: listAccounts(user.id),
  };
};

export const actions: Actions = {
  createInstitution: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, institutionFields);
    const parsed = parseForm(institutionInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "createInstitution",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const created = createInstitution(user.id, parsed.data);
      return {
        success: true as const,
        action: "createInstitution" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("createInstitution", err, values);
    }
  },

  updateInstitution: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["id", ...institutionFields]);
    const parsed = parseForm(
      institutionInputSchema.extend({ id: idSchema }),
      form,
    );
    if (!parsed.ok) {
      return fail(400, {
        action: "updateInstitution",
        errors: parsed.errors,
        values,
      });
    }
    const { id, ...input } = parsed.data;
    try {
      updateInstitution(user.id, id, input);
      return {
        success: true as const,
        action: "updateInstitution" as const,
        id,
      };
    } catch (err) {
      return ledgerFailure("updateInstitution", err, values);
    }
  },

  deleteInstitution: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["id"]);
    const parsed = parseForm(idFormSchema("id"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteInstitution",
        errors: parsed.errors,
        values,
      });
    }
    try {
      deleteInstitution(user.id, parsed.data.id);
      return {
        success: true as const,
        action: "deleteInstitution" as const,
        id: parsed.data.id,
      };
    } catch (err) {
      return ledgerFailure("deleteInstitution", err, values);
    }
  },

  createAccount: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, accountFields);
    const parsed = parseForm(accountInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "createAccount",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const created = createAccount(user.id, parsed.data);
      return {
        success: true as const,
        action: "createAccount" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("createAccount", err, values);
    }
  },
};
