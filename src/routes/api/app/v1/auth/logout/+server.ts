import { json } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { invalidateSession } from "$lib/server/auth/sessions";
import type { RequestHandler } from "./$types";

/** Ends the session the request was made with; the token is worthless afterwards. */
export const POST: RequestHandler = async ({ locals }) => {
  requireUser(locals);
  if (locals.session) await invalidateSession(locals.session.id);
  return json({ ok: true });
};
