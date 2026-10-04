import { FULL_SHARE_BPS } from "$lib/money";
import { requireUser } from "$lib/server/auth/guards";
import { listAccounts, localToday } from "$lib/server/ledger";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  const today = localToday();
  const accounts = listAccounts(user.id, today);
  return {
    today,
    hasShared: accounts.some((a) => !a.archived && a.shareBps < FULL_SHARE_BPS),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      iban: a.iban,
      archived: a.archived,
    })),
  };
};
