import { requireUser } from "$lib/server/auth/guards";
import { listAccounts, localToday } from "$lib/server/ledger";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  const today = localToday();
  return {
    today,
    accounts: listAccounts(user.id, today).map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      iban: a.iban,
      archived: a.archived,
    })),
  };
};
