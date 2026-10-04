import { error, fail } from "@sveltejs/kit";
import { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import {
  countPrices,
  createSecurity,
  deletePrice,
  deleteSecurity,
  getMarketDataSettings,
  getQuoteProvider,
  getSecurity,
  investmentsOverview,
  listPrices,
  listSecurities,
  priceInputSchema,
  QuoteProviderError,
  securityInputSchema,
  setManualPrice,
  updateSecurity,
} from "$lib/server/investments";
import { localToday } from "$lib/server/ledger";
import { ledgerFailure, orNotFound } from "$lib/server/ledger/http";
import { idFormSchema, idSchema } from "$lib/server/ledger/schemas";
import type { Actions, PageServerLoad } from "./$types";

const securityFields = ["name", "kind", "isin", "symbol", "currency"] as const;
const priceFields = ["date", "price"] as const;

const lookupSchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, "Enter at least 2 characters.")
    .max(100, "Enter at most 100 characters."),
});

const querySchema = z.object({
  prices: idSchema.max(64).optional(),
  all: z.literal("1").optional(),
});

export const load: PageServerLoad = ({ locals, url }) => {
  const user = requireUser(locals);
  const query = querySchema.safeParse({
    prices: url.searchParams.get("prices") || undefined,
    all: url.searchParams.get("all") || undefined,
  });
  if (!query.success) error(404, "Not found");
  const securityId = query.data.prices ?? null;
  const all = query.data.all === "1";
  const settings = getMarketDataSettings(user.id);
  return {
    overview: investmentsOverview(user.id, localToday()),
    securities: listSecurities(user.id),
    marketData: {
      enabled: settings.enabled,
      canLookup: settings.enabled && getQuoteProvider() !== null,
    },
    priceHistory: securityId
      ? {
          security: orNotFound(() => getSecurity(user.id, securityId)),
          prices: orNotFound(() =>
            listPrices(
              user.id,
              securityId,
              all ? Number.MAX_SAFE_INTEGER : undefined,
            ),
          ),
          total: orNotFound(() => countPrices(user.id, securityId)),
        }
      : null,
  };
};

export const actions: Actions = {
  createSecurity: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, securityFields);
    const parsed = parseForm(securityInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "createSecurity",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const created = createSecurity(user.id, parsed.data);
      return {
        success: true as const,
        action: "createSecurity" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("createSecurity", err, values);
    }
  },

  updateSecurity: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["securityId", ...securityFields]);
    const idParsed = parseForm(idFormSchema("securityId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "updateSecurity",
        errors: idParsed.errors,
        values,
      });
    }
    orNotFound(() => getSecurity(user.id, idParsed.data.securityId));
    const parsed = parseForm(securityInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "updateSecurity",
        errors: parsed.errors,
        values,
      });
    }
    try {
      updateSecurity(user.id, idParsed.data.securityId, parsed.data);
      return {
        success: true as const,
        action: "updateSecurity" as const,
        id: idParsed.data.securityId,
      };
    } catch (err) {
      return ledgerFailure("updateSecurity", err, values);
    }
  },

  deleteSecurity: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["securityId"]);
    const parsed = parseForm(idFormSchema("securityId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteSecurity",
        errors: parsed.errors,
        values,
      });
    }
    try {
      deleteSecurity(user.id, parsed.data.securityId);
      return {
        success: true as const,
        action: "deleteSecurity" as const,
        id: parsed.data.securityId,
      };
    } catch (err) {
      return ledgerFailure("deleteSecurity", err, values);
    }
  },

  lookup: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["q"]);
    const parsed = parseForm(lookupSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "lookup", errors: parsed.errors, values });
    }
    const provider = getQuoteProvider();
    if (!provider) {
      return fail(400, {
        action: "lookup",
        errors: { form: ["No market data provider is available."] },
        values,
      });
    }
    // A lookup sends the search text out, so it follows the same opt-in.
    if (!getMarketDataSettings(user.id).enabled) {
      return fail(400, {
        action: "lookup",
        errors: {
          form: [
            "Turn on market data in Settings to look up securities. A lookup sends your search text to the provider.",
          ],
        },
        values,
      });
    }
    try {
      const matches = await provider.search(parsed.data.q);
      return {
        success: true as const,
        action: "lookup" as const,
        matches: matches.slice(0, 10),
      };
    } catch (err) {
      // The search text is never logged; only provider errors written for users are shown.
      console.error(
        "security lookup failed:",
        err instanceof Error ? err.name : "unknown error",
      );
      return fail(400, {
        action: "lookup",
        errors: {
          form: [
            err instanceof QuoteProviderError
              ? err.message
              : "The lookup failed. Please try again.",
          ],
        },
        values,
      });
    }
  },

  setPrice: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["securityId", ...priceFields]);
    const idParsed = parseForm(idFormSchema("securityId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "setPrice",
        errors: idParsed.errors,
        values,
      });
    }
    orNotFound(() => getSecurity(user.id, idParsed.data.securityId));
    const parsed = parseForm(priceInputSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "setPrice", errors: parsed.errors, values });
    }
    try {
      setManualPrice(user.id, idParsed.data.securityId, parsed.data);
      return { success: true as const, action: "setPrice" as const };
    } catch (err) {
      return ledgerFailure("setPrice", err, values);
    }
  },

  deletePrice: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["priceId"]);
    const parsed = parseForm(idFormSchema("priceId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deletePrice",
        errors: parsed.errors,
        values,
      });
    }
    try {
      deletePrice(user.id, parsed.data.priceId);
      return { success: true as const, action: "deletePrice" as const };
    } catch (err) {
      return ledgerFailure("deletePrice", err, values);
    }
  },
};
