import { fail } from "@sveltejs/kit";
import type { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import { localToday } from "$lib/server/ledger/balances";
import { ledgerFailure } from "$lib/server/ledger/http";
import {
  confirmSeries,
  dismissSeries,
  editSeries,
  idFormSchema,
  listRecurring,
  recurringTotals,
  restoreSeries,
  seriesEditSchema,
  syncRecurring,
} from "$lib/server/recurring";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  await syncRecurring(user.id);
  const series = await listRecurring(user.id, localToday());
  return { series, totals: recurringTotals(series) };
};

function formAction<S extends z.ZodType>(
  action: string,
  schema: S,
  fields: readonly string[],
  run: (userId: string, data: z.output<S>) => Promise<void>,
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
  confirm: formAction("confirm", idFormSchema("id"), ["id"], (userId, { id }) =>
    confirmSeries(userId, id),
  ),
  dismiss: formAction("dismiss", idFormSchema("id"), ["id"], (userId, { id }) =>
    dismissSeries(userId, id),
  ),
  restore: formAction("restore", idFormSchema("id"), ["id"], (userId, { id }) =>
    restoreSeries(userId, id),
  ),
  edit: formAction(
    "edit",
    seriesEditSchema.and(idFormSchema("id")),
    ["id", "name", "cadence", "amount"],
    (userId, { id, ...input }) => editSeries(userId, id, input),
  ),
} satisfies Actions;
