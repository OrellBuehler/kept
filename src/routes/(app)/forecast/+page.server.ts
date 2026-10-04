import { fail } from "@sveltejs/kit";
import type { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import {
  accountSettingsInputSchema,
  createPlannedItem,
  deletePlannedItem,
  forecast,
  HORIZONS,
  idFormSchema,
  listAccountSettings,
  listPlannedItems,
  parseHorizon,
  plannedItemInputSchema,
  saveAccountSettings,
  updatePlannedItem,
} from "$lib/server/forecast";
import { parseForm, safeValues } from "$lib/server/forms";
import { localToday } from "$lib/server/ledger/balances";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

const plannedFields = [
  "label",
  "date",
  "direction",
  "amount",
  "accountId",
  "currency",
] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const today = localToday();
  const days = parseHorizon(url.searchParams.get("days"));
  return {
    today,
    days,
    horizons: HORIZONS,
    forecast: await forecast(user.id, today, days),
    planned: listPlannedItems(user.id),
    settings: listAccountSettings(user.id),
  };
};

function formAction<S extends z.ZodType>(
  action: string,
  schema: S,
  fields: readonly string[],
  run: (userId: string, data: z.output<S>) => unknown,
) {
  return async ({ locals, request }: RequestEvent) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, fields);
    const parsed = parseForm(schema, form);
    if (!parsed.ok) {
      return fail(400, { action, errors: parsed.errors, values });
    }
    try {
      await run(user.id, parsed.data);
      return { success: true as const, action };
    } catch (err) {
      return ledgerFailure(action, err, values);
    }
  };
}

export const actions = {
  createPlanned: formAction(
    "createPlanned",
    plannedItemInputSchema,
    plannedFields,
    (userId, data) => createPlannedItem(userId, data),
  ),
  updatePlanned: formAction(
    "updatePlanned",
    plannedItemInputSchema.and(idFormSchema("id")),
    ["id", ...plannedFields],
    (userId, { id, ...input }) => updatePlannedItem(userId, id, input),
  ),
  deletePlanned: formAction(
    "deletePlanned",
    idFormSchema("id"),
    ["id"],
    (userId, { id }) => deletePlannedItem(userId, id),
  ),
  saveSettings: formAction(
    "saveSettings",
    accountSettingsInputSchema,
    ["accountId", "threshold", "defaultPayment"],
    (userId, data) => saveAccountSettings(userId, data),
  ),
} satisfies Actions;
