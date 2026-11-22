import { json } from "@sveltejs/kit";
import { z } from "zod";
import { jsonMessage, readAppBody } from "$lib/server/app-api/http";
import { takeAppSignIn } from "$lib/server/auth/challenges";
import { clientKey, issueLogin } from "$lib/server/auth/login";
import { appSignInLimiter } from "$lib/server/auth/rate-limit";
import { tooManyRequests } from "$lib/server/external-api/gate";
import type { RequestHandler } from "./$types";

const bodySchema = z.object({
  request: z.string().min(1).max(200),
  secret: z.string().min(1).max(200),
  code: z.string().min(1).max(200),
});

/**
 * Last step of a sign-in through the browser: the session for a request the
 * user approved on the web. It takes the secret the app kept and the code the
 * approval sent back to it. `409` while it is not approved yet, `410` when it
 * expired, was used or secret or code are not its own.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const gate = appSignInLimiter.acquire("token", clientKey(getClientAddress));
  if (!gate.allowed) {
    return tooManyRequests(
      gate.retryAfterMs,
      `Too many attempts, try again in ${gate.retryAfterMinutes} minutes.`,
    );
  }
  const body = await readAppBody(request, bodySchema);
  if (body instanceof Response) return body;
  const taken = await takeAppSignIn(body.request, body.secret, body.code);
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
