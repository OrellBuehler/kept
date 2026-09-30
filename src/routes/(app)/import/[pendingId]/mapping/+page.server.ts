import { fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { formToObject } from "$lib/server/forms";
import {
  getPendingMeta,
  mappingContext,
  saveCsvProfile,
} from "$lib/server/imports";
import { ledgerFailure, orNotFound } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, params }) => {
  const user = requireUser(locals);
  const meta = orNotFound(() => getPendingMeta(user.id, params.pendingId));
  if (meta.format === "camt053") redirect(303, `/import/${meta.id}`);
  return orNotFound(() => mappingContext(user.id, meta.id));
};

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const meta = orNotFound(() => getPendingMeta(user.id, params.pendingId));
    const fields = formToObject(await request.formData());
    const values = { name: fields.name ?? "", profile: fields.profile ?? "" };

    let profile: unknown;
    try {
      profile = JSON.parse(values.profile);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return fail(400, {
        action: "save",
        errors: { profile: ["The profile is not valid JSON."] },
        values,
      });
    }
    try {
      saveCsvProfile(user.id, meta.accountId, values.name, profile);
    } catch (err) {
      return ledgerFailure("save", err, values);
    }
    redirect(303, `/import/${meta.id}`);
  },
};
