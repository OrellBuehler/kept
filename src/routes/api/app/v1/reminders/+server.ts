import { error, json } from "@sveltejs/kit";
import { reminderQuerySchema, reminders } from "$lib/server/app-api/reminders";
import { requireUser } from "$lib/server/auth/guards";
import type { RequestHandler } from "./$types";

/** What the device should notify about: polled in the background, shown as local notifications. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals);
  const parsed = reminderQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    error(400, `Invalid ${issue?.path.join(".")}: ${issue?.message}`);
  }
  return json(await reminders(user.id, parsed.data));
};
