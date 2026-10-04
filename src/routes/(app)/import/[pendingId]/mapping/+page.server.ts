import { fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import {
  getPendingMeta,
  mappingContext,
  saveCsvProfile,
} from "$lib/server/imports";
import {
  ledgerFailure,
  orNotFound,
  orNotFoundAsync,
} from "$lib/server/ledger/http";
import { z } from "zod";
import type { Actions, PageServerLoad } from "./$types";

const formSchema = z.object({
  name: z.string(),
  profile: z.string().min(1, "Required."),
});

export const load: PageServerLoad = async ({ locals, params }) => {
  const user = requireUser(locals);
  const meta = orNotFound(() => getPendingMeta(user.id, params.pendingId));
  if (meta.format === "camt053") redirect(303, `/import/${meta.id}`);
  return orNotFoundAsync(() => mappingContext(user.id, meta.id));
};

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const meta = orNotFound(() => getPendingMeta(user.id, params.pendingId));
    let form: FormData;
    try {
      form = await request.formData();
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      return fail(400, {
        action: "save",
        errors: { form: ["The form could not be read."] },
        values: { name: "", profile: "" },
      });
    }
    const values = safeValues(form, ["name", "profile"]) as {
      name: string;
      profile: string;
    };
    const parsed = parseForm(formSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "save", errors: parsed.errors, values });
    }

    let profile: unknown;
    try {
      profile = JSON.parse(parsed.data.profile);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return fail(400, {
        action: "save",
        errors: { profile: ["The profile is not valid JSON."] },
        values,
      });
    }
    try {
      await saveCsvProfile(user.id, meta.accountId, parsed.data.name, profile);
    } catch (err) {
      return ledgerFailure("save", err, values);
    }
    redirect(303, `/import/${meta.id}`);
  },
};
