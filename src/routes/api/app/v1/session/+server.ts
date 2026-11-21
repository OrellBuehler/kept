import { json } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { getTwoFactorStatus } from "$lib/server/auth/two-factor";
import { overdueBillCount } from "$lib/server/dashboard";
import { localToday } from "$lib/server/ledger/balances";
import { getPreferences } from "$lib/server/preferences";
import type { RequestHandler } from "./$types";

/** Who is signed in, with what every screen needs: the web's layout data. */
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals);
  const today = localToday();
  return json({
    user,
    today,
    overdueBills: await overdueBillCount(user.id, today),
    preferences: await getPreferences(user.id),
    twoFactor: (await getTwoFactorStatus(user.id)).enabled,
    sessionExpiresAt: locals.session?.expiresAt.toISOString() ?? null,
  });
};
