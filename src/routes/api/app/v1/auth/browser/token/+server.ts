import { json } from "@sveltejs/kit";
import { z } from "zod";
import { jsonMessage, readAppBody } from "$lib/server/app-api/http";
import { takeAppSignIn } from "$lib/server/auth/challenges";
import { issueLogin } from "$lib/server/auth/login";
import type { RequestHandler } from "./$types";

const bodySchema = z.object({
  request: z.string().min(1).max(200),
  secret: z.string().min(1).max(200),
});

/**
 * Last step of a sign-in through the browser: the session for a request the
 * user approved on the web. `409` while it is not approved yet, `410` when it
 * expired, was used or the secret is not its own.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = await readAppBody(request, bodySchema);
  if (body instanceof Response) return body;
  const taken = await takeAppSignIn(body.request, body.secret);
  if (taken === "pending") {
    return jsonMessage("Finish signing in in the browser first.", 409);
  }
  if (!taken) return jsonMessage("Your sign-in expired. Start again.", 410);
  const result = await issueLogin(taken.userId);
  return json({
    status: "ok",
    token: result.token,
    expiresAt: result.session.expiresAt.toISOString(),
    user: result.user,
  });
};
