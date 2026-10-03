import { json } from "@sveltejs/kit";
import { clientKey } from "$lib/server/auth/login";
import { passkeyOptionsLimiter } from "$lib/server/auth/rate-limit";
import {
  PENDING_COOKIE,
  createWebauthnChallenge,
  getPendingLogin,
  setPendingChallenge,
} from "$lib/server/auth/challenges";
import { readJsonBody } from "$lib/server/auth/http";
import { beginAuthentication, webauthnConfig } from "$lib/server/auth/passkeys";
import { passkeyLoginOptionsSchema } from "$lib/server/auth/schemas";
import { getTwoFactorStatus } from "$lib/server/auth/two-factor";
import type { RequestHandler } from "./$types";

/**
 * Public. "second_factor" needs the pending-login cookie and only offers that
 * user's passkeys; "passwordless" starts a usernameless ceremony.
 */
export const POST: RequestHandler = async ({
  request,
  url,
  cookies,
  getClientAddress,
}) => {
  const body = await readJsonBody(request, url, passkeyLoginOptionsSchema);
  const config = webauthnConfig(url);
  const gate = passkeyOptionsLimiter.acquire(
    "options",
    clientKey(getClientAddress),
  );
  if (!gate.allowed) {
    return json(
      {
        message: `Too many attempts, try again in ${gate.retryAfterMinutes} minutes.`,
      },
      { status: 429 },
    );
  }

  if (body.mode === "passwordless") {
    const options = await beginAuthentication(null, config);
    const challengeId = createWebauthnChallenge(
      "passkey_login",
      null,
      options.challenge,
    );
    return json({ options, challengeId });
  }

  const pending = getPendingLogin(cookies.get(PENDING_COOKIE));
  if (!pending) {
    return json(
      { message: "Your sign-in expired. Start again." },
      { status: 401 },
    );
  }
  if (getTwoFactorStatus(pending.userId).passkeyCount === 0) {
    return json({ message: "No passkeys registered." }, { status: 400 });
  }
  const options = await beginAuthentication(pending.userId, config);
  setPendingChallenge(pending.id, options.challenge);
  return json({ options });
};
