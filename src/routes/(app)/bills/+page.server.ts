import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { allocateFromInput } from "$lib/server/bills/allocations";
import { todayLocal } from "$lib/server/bills/dates";
import {
  confirmFormSchema,
  dismissFormSchema,
} from "$lib/server/bills/schemas";
import {
  filterBills,
  paginateBills,
  parseBillListQuery,
} from "$lib/server/bills/list";
import { billViews, countBills, groupBills } from "$lib/server/bills/status";
import {
  dismissSuggestion,
  runAutoMatching,
  type SuggestionView,
} from "$lib/server/bills/suggestions";
import { parseForm, safeValues } from "$lib/server/forms";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";
import { describeError } from "$lib/server/errors";

export const load: PageServerLoad = ({ locals, url }) => {
  const user = requireUser(locals);
  const today = todayLocal();
  let autoMatched = 0;
  let suggestions: SuggestionView[] = [];
  let suggestionsTruncated = false;
  let matchingFailed = false;
  try {
    const result = runAutoMatching(user.id);
    autoMatched = result.matched;
    suggestions = result.suggestions;
    suggestionsTruncated = result.truncated;
  } catch (err) {
    // The overview must still render; the flag tells the UI matching did not run.
    console.warn("auto-matching failed", describeError(err));
    matchingFailed = true;
  }
  const views = billViews(user.id, { today });
  const all = groupBills(views, { today });
  const query = parseBillListQuery(url.searchParams);
  return {
    today,
    groups: {
      overdue: all.overdue,
      dueSoon: all.dueSoon,
      awaitingRefund: all.awaitingRefund,
    },
    suggestions,
    suggestionsTruncated,
    matchingFailed,
    counts: countBills(views, all),
    autoMatched,
    query,
    list: paginateBills(filterBills(views, query), query.page),
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
