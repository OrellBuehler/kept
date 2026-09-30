import { requireUser } from "$lib/server/auth/guards";
import { overdueBillCount } from "$lib/server/dashboard";
import { localToday } from "$lib/server/ledger/balances";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  return { user, overdueBills: overdueBillCount(user.id, localToday()) };
};
