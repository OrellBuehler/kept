import { redirect } from "@sveltejs/kit";
import {
  deleteSessionCookie,
  invalidateSession,
} from "$lib/server/auth/sessions";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  redirect(303, "/");
};

export const actions: Actions = {
  default: async ({ locals, cookies }) => {
    if (locals.session) await invalidateSession(locals.session.id);
    deleteSessionCookie(cookies);
    redirect(303, "/login");
  },
};
