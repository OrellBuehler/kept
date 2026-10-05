import { requireUser } from "$lib/server/auth/guards";
import { overdueBillCount } from "$lib/server/dashboard";
import { localToday } from "$lib/server/ledger/balances";
import { getPreferences } from "$lib/server/preferences";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  return {
    user,
    overdueBills: await overdueBillCount(user.id, localToday()),
    preferences: getPreferences(user.id),
  };
};
