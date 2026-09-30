import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { allocateFromInput } from "$lib/server/bills/allocations";
import { todayLocal } from "$lib/server/bills/dates";
import {
  confirmFormSchema,
  dismissFormSchema,
} from "$lib/server/bills/schemas";
import { billViews, countBills, groupBills } from "$lib/server/bills/status";
import {
  dismissSuggestion,
  getSuggestions,
  runAutoMatching,
} from "$lib/server/bills/suggestions";
import { parseForm, safeValues } from "$lib/server/forms";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  const autoMatched = runAutoMatching(user.id);
  const today = todayLocal();
  const views = billViews(user.id, { today });
  const { cancelled, ...groups } = groupBills(views, { today });
  return {
    today,
    groups,
    cancelled,
    suggestions: getSuggestions(user.id),
    counts: countBills(views, { ...groups, cancelled }),
    autoMatched,
  };
};

const confirmFields = ["billId", "transactionId", "amount"] as const;

export const actions: Actions = {
  confirmSuggestion: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, confirmFields);
    const parsed = parseForm(confirmFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "confirmSuggestion",
        errors: parsed.errors,
        values,
      });
    }
    try {
      allocateFromInput(
        user.id,
        parsed.data.billId,
        parsed.data.transactionId,
        parsed.data.amount,
        "user",
      );
      return { success: true as const, action: "confirmSuggestion" as const };
    } catch (err) {
      return ledgerFailure("confirmSuggestion", err, values);
    }
  },

  dismissSuggestion: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["billId", "transactionId"]);
    const parsed = parseForm(dismissFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "dismissSuggestion",
        errors: parsed.errors,
        values,
      });
    }
    try {
      dismissSuggestion(user.id, parsed.data.billId, parsed.data.transactionId);
      return { success: true as const, action: "dismissSuggestion" as const };
    } catch (err) {
      return ledgerFailure("dismissSuggestion", err, values);
    }
  },
};
