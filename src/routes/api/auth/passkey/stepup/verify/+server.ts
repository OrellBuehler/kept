import { json } from "@sveltejs/kit";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { takeWebauthnChallenge } from "$lib/server/auth/challenges";
import { requireUser } from "$lib/server/auth/guards";
import { readJsonBody } from "$lib/server/auth/http";
import {
  finishAuthentication,
  webauthnConfig,
} from "$lib/server/auth/passkeys";
import { RateLimitedError } from "$lib/server/auth/rate-limit";
import { passkeyStepUpVerifySchema } from "$lib/server/auth/schemas";
import {
  getTwoFactorStatus,
  markSessionReauthenticated,
  reauthenticatePasswordOnly,
} from "$lib/server/auth/two-factor";
import { AuthError } from "$lib/server/auth/types";
import type { RequestHandler } from "./$types";

/** Password plus a fresh assertion from the caller's own passkey starts the step-up window. */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals);
  if (!locals.session) return json({ message: "No session." }, { status: 401 });
  if (getTwoFactorStatus(user.id).totpEnabled) {
    return json({ message: "Use your authenticator code." }, { status: 400 });
  }
  const body = await readJsonBody(request, url, passkeyStepUpVerifySchema);

  const challenge = takeWebauthnChallenge(
    body.challengeId,
    "passkey_stepup",
    user.id,
  );
  const verifiedUser = challenge
    ? await finishAuthentication(
        body.credential as unknown as AuthenticationResponseJSON,
        challenge,
        webauthnConfig(url),
        user.id,
      )
    : null;
  if (verifiedUser !== user.id) {
    return json(
      { message: "The passkey could not be verified." },
      { status: 400 },
    );
  }

  try {
    await reauthenticatePasswordOnly(user.id, body.password);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return json({ message: err.message }, { status: 429 });
    }
    if (err instanceof AuthError) {
      return json({ message: "Password is incorrect." }, { status: 400 });
    }
    throw err;
  }
  markSessionReauthenticated(user.id, locals.session.id);
  return json({ reauthed: true });
};
