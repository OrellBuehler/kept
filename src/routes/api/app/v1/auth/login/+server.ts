import { json } from "@sveltejs/kit";
import { z } from "zod";
import { jsonMessage, readAppBody } from "$lib/server/app-api/http";
import {
  RateLimitedError,
  authenticate,
  clientKey,
} from "$lib/server/auth/login";
import { loginSchema } from "$lib/server/auth/schemas";
import { getTwoFactorStatus } from "$lib/server/auth/two-factor";
import { getPendingLogin } from "$lib/server/auth/challenges";
import { tooManyRequests } from "$lib/server/external-api/gate";
import type { RequestHandler } from "./$types";

const bodySchema = z.object({
  username: loginSchema.shape.username,
  password: loginSchema.shape.password,
});

/**
 * Signs an app in. Answers `{ status: "ok", token, expiresAt, user }`, where
 * `token` is the session the app sends as bearer token from then on, or
 * `{ status: "second_factor", pendingToken, … }` when the account needs a code
 * (then `auth/verify`). Shares the login rate limits with the web.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const body = await readAppBody(request, bodySchema);
  if (body instanceof Response) return body;
  let result;
  try {
    result = await authenticate(
      body.username,
      body.password,
      clientKey(getClientAddress),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return tooManyRequests(err.retryAfterMinutes * 60_000, err.message);
    }
    throw err;
  }
  if (!result) return jsonMessage("Invalid username or password.", 401);

  if ("secondFactorRequired" in result) {
    const pending = await getPendingLogin(result.token);
    const status = pending
      ? await getTwoFactorStatus(pending.userId)
      : { totpEnabled: true, passkeyCount: 0 };
    return json({
      status: "second_factor",
      pendingToken: result.token,
      expiresAt: result.expiresAt.toISOString(),
      /** False for an account that only has passkeys: the app cannot use those, a recovery code is the way in. */
      totp: status.totpEnabled,
    });
  }
  return json({
    status: "ok",
    token: result.token,
    expiresAt: result.session.expiresAt.toISOString(),
    user: result.user,
  });
};
