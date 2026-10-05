import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import {
  getMarketDataSettings,
  getQuoteProvider,
  marketDataSettingsSchema,
  refreshPrices,
  setMarketDataEnabled,
} from "$lib/server/investments";
import { localToday } from "$lib/server/ledger";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  return {
    settings: await getMarketDataSettings(user.id),
    providerAvailable: getQuoteProvider() !== null,
  };
};

export const actions: Actions = {
  save: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const parsed = parseForm(marketDataSettingsSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "save",
        errors: parsed.errors,
        values: safeValues(form, ["enabled"]),
      });
    }
    await setMarketDataEnabled(user.id, parsed.data.enabled);
    return {
      success: true as const,
      action: "save" as const,
      enabled: parsed.data.enabled,
    };
  },

  refresh: async ({ locals }) => {
    const user = requireUser(locals);
    try {
      const result = await refreshPrices(user.id, localToday());
      return { success: true as const, action: "refresh" as const, result };
    } catch (err) {
      return ledgerFailure("refresh", err);
    }
  },
};
