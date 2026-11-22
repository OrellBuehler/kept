import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm } from "$lib/server/forms";
import { markAccountChecked } from "$lib/server/ledger/accounts";
import { ledgerFailure } from "$lib/server/ledger/http";
import { idFormSchema } from "$lib/server/ledger/schemas";
import { dashboard } from "$lib/server/dashboard";
import { negativeBalanceAlerts } from "$lib/server/forecast";
import { localToday } from "$lib/server/ledger/balances";
import { listNeedsAmount } from "$lib/server/transfers/manual";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const today = localToday();
  return {
    today,
    forecastAlerts: await negativeBalanceAlerts(user.id, today),
    /** FX transfers waiting for the received amount, for a dashboard hint. */
    needsAmount: await listNeedsAmount(user.id),
    dashboard: await dashboard(user.id, today, {
      range: url.searchParams.get("range"),
    }),
  };
};

export const actions: Actions = {
  /** "No new transactions": the account is up to date although nothing was imported. */
  markChecked: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(
      idFormSchema("accountId"),
      await request.formData(),
    );
    if (!parsed.ok) {
      return fail(400, { action: "markChecked", errors: parsed.errors });
    }
    try {
      await markAccountChecked(user.id, parsed.data.accountId);
      return { success: true as const, action: "markChecked" as const };
    } catch (err) {
      return ledgerFailure("markChecked", err);
    }
  },
};
