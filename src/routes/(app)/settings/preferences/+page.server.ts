import { z } from "zod";
import { fail } from "@sveltejs/kit";
import { preferencesSchema } from "$lib/preferences";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm } from "$lib/server/forms";
import { getPreferences, updatePreferences } from "$lib/server/preferences";
import type { Actions, PageServerLoad } from "./$types";

const blurSchema = z.object({
  blurAmounts: z
    .enum(["true", "false"], "Send true or false.")
    .transform((v) => v === "true"),
});

export const load: PageServerLoad = ({ locals }) => {
  return { preferences: getPreferences(requireUser(locals).id) };
};

export const actions: Actions = {
  save: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(preferencesSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    updatePreferences(user.id, parsed.data);
    return { success: true as const };
  },

  setBlur: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(blurSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    updatePreferences(user.id, parsed.data);
    return { success: true as const };
  },
};
