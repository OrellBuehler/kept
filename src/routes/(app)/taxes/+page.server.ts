import { fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import { listAccounts, localToday } from "$lib/server/ledger";
import { ledgerFailure } from "$lib/server/ledger/http";
import {
  TAX_YEAR_FORM_FIELDS,
  taxYearInputSchema,
} from "$lib/server/tax/schemas";
import { getPreferences } from "$lib/server/preferences";
import { listTaxYears, upsertTaxYear } from "$lib/server/tax/tax";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const today = localToday();
  return {
    years: listTaxYears(user.id),
    defaultYear: Number(today.slice(0, 4)) - 1,
    defaultCurrency:
      (await listAccounts(user.id, today)).find((a) => !a.archived)?.currency ??
      getPreferences(user.id).defaultCurrency,
  };
};

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, TAX_YEAR_FORM_FIELDS);
    const parsed = parseForm(taxYearInputSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "create", errors: parsed.errors, values });
    }
    try {
      upsertTaxYear(user.id, parsed.data);
    } catch (err) {
      return ledgerFailure("create", err, values);
    }
    redirect(303, `/taxes/${parsed.data.year}`);
  },
};
