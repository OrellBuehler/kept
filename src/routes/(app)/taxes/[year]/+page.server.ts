import { error, fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { minor } from "$lib/money";
import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
import { parseForm, safeValues } from "$lib/server/forms";
import { localToday } from "$lib/server/ledger";
import { pillar3aOverview } from "$lib/server/pillar3a";
import { ledgerFailure } from "$lib/server/ledger/http";
import { idFormSchema } from "$lib/server/ledger/schemas";
import {
  TAX_CREDIT_FORM_FIELDS,
  TAX_YEAR_FORM_FIELDS,
  parseYearParam,
  taxCreditIdSchema,
  taxCreditInputSchema,
  taxYearInputSchema,
} from "$lib/server/tax/schemas";
import {
  deductionExcludeSchema,
  deductionMappingSchema,
  deductionSummary,
  listDeductionMappings,
  setCategoryDeduction,
  setTransactionDeductionExcluded,
} from "$lib/server/tax/deductions";
import {
  addTaxCredit,
  deleteTaxCredit,
  deleteTaxYear,
  reconcileYear,
  setTransactionTaxYear,
  upsertTaxYear,
} from "$lib/server/tax/tax";
import type { Actions, PageServerLoad } from "./$types";

function yearOf(params: { year: string }): number {
  const year = parseYearParam(params.year);
  if (year === null) error(404, "Tax year not found.");
  return year;
}

export const load: PageServerLoad = ({ locals, params }) => {
  const user = requireUser(locals);
  const reconciliation = reconcileYear(user.id, yearOf(params));
  if (!reconciliation) error(404, "Tax year not found.");
  const taxYear = reconciliation.year.year;
  const deductions = deductionSummary(user.id, taxYear);
  const overview = pillar3aOverview(user.id, localToday());
  const deductible =
    deductions.totals.find(
      (t) => t.type === "pillar_3a" && t.currency === PILLAR_3A_CURRENCY,
    )?.total ?? minor(0);
  const excluded = deductions.excluded
    .filter((l) => l.type === "pillar_3a" && l.currency === PILLAR_3A_CURRENCY)
    .reduce((sum, l) => sum + l.amount, 0);
  const row = overview.years.find((y) => y.year === taxYear) ?? null;
  return {
    reconciliation,
    deductions,
    deductionMappings: listDeductionMappings(user.id),
    // Only worth a card when the user tracks 3a at all.
    pillar3a:
      overview.portfolios.length > 0 || deductible !== 0
        ? {
            limit: row?.limit ?? null,
            limitUnconfirmed: row?.limitUnconfirmed ?? false,
            ordinary: row?.ordinary ?? minor(0),
            buyIn: row?.buyIn ?? minor(0),
            deductible,
            excluded: minor(excluded),
          }
        : null,
  };
};

export const actions: Actions = {
  saveDetails: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const year = yearOf(params);
    const form = await request.formData();
    const values = safeValues(form, TAX_YEAR_FORM_FIELDS);
    const parsed = parseForm(taxYearInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "saveDetails",
        errors: parsed.errors,
        values,
      });
    }
    try {
      upsertTaxYear(user.id, { ...parsed.data, year });
      return { success: true as const, action: "saveDetails" as const };
    } catch (err) {
      return ledgerFailure("saveDetails", err, values);
    }
  },

  deleteYear: ({ locals, params }) => {
    const user = requireUser(locals);
    try {
      deleteTaxYear(user.id, yearOf(params));
    } catch (err) {
      return ledgerFailure("deleteYear", err);
    }
    redirect(303, "/taxes");
  },

  addCredit: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const year = yearOf(params);
    const current = reconcileYear(user.id, year);
    if (!current) error(404, "Tax year not found.");
    const form = await request.formData();
    const values = safeValues(form, TAX_CREDIT_FORM_FIELDS);
    const parsed = parseForm(taxCreditInputSchema(current.year.currency), form);
    if (!parsed.ok) {
      return fail(400, { action: "addCredit", errors: parsed.errors, values });
    }
    try {
      addTaxCredit(user.id, year, parsed.data);
      return { success: true as const, action: "addCredit" as const };
    } catch (err) {
      return ledgerFailure("addCredit", err, values);
    }
  },

  deleteCredit: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["creditId"]);
    const parsed = parseForm(taxCreditIdSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteCredit",
        errors: parsed.errors,
        values,
      });
    }
    try {
      deleteTaxCredit(user.id, parsed.data.creditId);
      return { success: true as const, action: "deleteCredit" as const };
    } catch (err) {
      return ledgerFailure("deleteCredit", err, values);
    }
  },

  tag: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const year = yearOf(params);
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(idFormSchema("transactionId"), form);
    if (!parsed.ok) {
      return fail(400, { action: "tag", errors: parsed.errors, values });
    }
    try {
      setTransactionTaxYear(user.id, parsed.data.transactionId, year);
      return { success: true as const, action: "tag" as const };
    } catch (err) {
      return ledgerFailure("tag", err, values);
    }
  },

  untag: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(idFormSchema("transactionId"), form);
    if (!parsed.ok) {
      return fail(400, { action: "untag", errors: parsed.errors, values });
    }
    try {
      setTransactionTaxYear(user.id, parsed.data.transactionId, null);
      return { success: true as const, action: "untag" as const };
    } catch (err) {
      return ledgerFailure("untag", err, values);
    }
  },

  setDeduction: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["categoryId", "deductionType"]);
    const parsed = parseForm(deductionMappingSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "setDeduction",
        errors: parsed.errors,
        values,
      });
    }
    try {
      setCategoryDeduction(
        user.id,
        parsed.data.categoryId,
        parsed.data.deductionType === "" ? null : parsed.data.deductionType,
      );
      return { success: true as const, action: "setDeduction" as const };
    } catch (err) {
      return ledgerFailure("setDeduction", err, values);
    }
  },

  excludeDeduction: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(deductionExcludeSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "excludeDeduction",
        errors: parsed.errors,
        values,
      });
    }
    try {
      setTransactionDeductionExcluded(user.id, parsed.data.transactionId, true);
      return { success: true as const, action: "excludeDeduction" as const };
    } catch (err) {
      return ledgerFailure("excludeDeduction", err, values);
    }
  },

  includeDeduction: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(deductionExcludeSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "includeDeduction",
        errors: parsed.errors,
        values,
      });
    }
    try {
      setTransactionDeductionExcluded(
        user.id,
        parsed.data.transactionId,
        false,
      );
      return { success: true as const, action: "includeDeduction" as const };
    } catch (err) {
      return ledgerFailure("includeDeduction", err, values);
    }
  },
};
