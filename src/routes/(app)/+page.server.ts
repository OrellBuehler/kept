import { requireUser } from "$lib/server/auth/guards";
import { dashboard } from "$lib/server/dashboard";
import { negativeBalanceAlerts } from "$lib/server/forecast";
import { localToday } from "$lib/server/ledger/balances";
import { listNeedsAmount } from "$lib/server/transfers/manual";
import type { PageServerLoad } from "./$types";

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
