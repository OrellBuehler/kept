import { redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  requireUser(locals);
  redirect(303, "/settings/account");
};
