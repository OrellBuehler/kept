import { json } from "@sveltejs/kit";
import { z } from "zod";
import { jsonMessage, readAppBody } from "$lib/server/app-api/http";
import { getPendingLogin } from "$lib/server/auth/challenges";
import {
  RateLimitedError,
  clientKey,
  completeSecondFactor,
} from "$lib/server/auth/login";
import { secondFactorSchema } from "$lib/server/auth/schemas";
import { AuthError } from "$lib/server/auth/types";
import { tooManyRequests } from "$lib/server/external-api/gate";
import type { RequestHandler } from "./$types";

const bodySchema = z.object({
  pendingToken: z.string().min(1).max(200),
  code: secondFactorSchema.shape.code,
});

/** Second sign-in step: an authenticator or recovery code for the `pendingToken` of `auth/login`. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const body = await readAppBody(request, bodySchema);
  if (body instanceof Response) return body;
  let result;
  try {
    result = await completeSecondFactor(
      body.pendingToken,
      body.code,
      clientKey(getClientAddress),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return tooManyRequests(err.retryAfterMinutes * 60_000, err.message);
    }
    if (err instanceof AuthError && err.code === "pending_expired") {
      return jsonMessage(err.message, 410);
    }
    throw err;
  }
  if (!result) {
    if (!(await getPendingLogin(body.pendingToken))) {
      return jsonMessage("Your sign-in expired. Start again.", 410);
    }
    return jsonMessage("That code is not valid.", 400);
  }
  return json({
    status: "ok",
    token: result.token,
    expiresAt: result.session.expiresAt.toISOString(),
    user: result.user,
  });
};
