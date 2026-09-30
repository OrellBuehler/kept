import { requireUser } from "$lib/server/auth/guards";
import { dashboard } from "$lib/server/dashboard";
import { localToday } from "$lib/server/ledger/balances";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const user = requireUser(locals);
  const today = localToday();
  return {
    today,
    dashboard: dashboard(user.id, today, {
      range: url.searchParams.get("range"),
    }),
  };
};
