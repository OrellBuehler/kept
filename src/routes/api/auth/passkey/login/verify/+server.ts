import { json } from "@sveltejs/kit";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  PENDING_COOKIE,
  deletePendingCookie,
  deletePendingLogin,
  getPendingLogin,
  recordPendingFailure,
  takePendingChallenge,
  takeWebauthnChallenge,
} from "$lib/server/auth/challenges";
import { readJsonBody } from "$lib/server/auth/http";
import { clientKey, issueLogin } from "$lib/server/auth/login";
import {
  finishAuthentication,
  webauthnConfig,
} from "$lib/server/auth/passkeys";
import {
  RateLimitedError,
  passkeyLoginLimiter,
  secondFactorLimiter,
} from "$lib/server/auth/rate-limit";
import { safeRedirectTo } from "$lib/server/auth/routing";
import { passkeyLoginVerifySchema } from "$lib/server/auth/schemas";
import { invalidateSession, setSessionCookie } from "$lib/server/auth/sessions";
import type { RequestHandler } from "./$types";

const invalid = () =>
  json({ message: "The passkey could not be verified." }, { status: 400 });

/**
 * Public. With a `challengeId` this is passwordless sign-in; without one it is
 * the second step of a password login and the pending-login cookie decides
 * whose passkeys are acceptable. Passkeys are always user-verified, so either
 * path ends in a full session.
 */
export const POST: RequestHandler = async ({
  request,
  url,
  cookies,
  locals,
  getClientAddress,
}) => {
  const body = await readJsonBody(request, url, passkeyLoginVerifySchema);
  const config = webauthnConfig(url);
  const ip = clientKey(getClientAddress);
  const credential = body.credential as unknown as AuthenticationResponseJSON;

  let userId: string | null = null;
  try {
    if (body.challengeId) {
      const release = passkeyLoginLimiter.acquireOrThrow("passkey", ip);
      const challenge = takeWebauthnChallenge(
        body.challengeId,
        "passkey_login",
        null,
      );
      if (!challenge) return invalid();
      userId = await finishAuthentication(credential, challenge, config, null);
      if (!userId) return invalid();
      release();
    } else {
      const pending = getPendingLogin(cookies.get(PENDING_COOKIE));
      if (!pending) {
        deletePendingCookie(cookies);
        return json(
          { message: "Your sign-in expired. Start again." },
          { status: 401 },
        );
      }
      const release = secondFactorLimiter.acquireOrThrow(pending.userId, ip);
      const challenge = takePendingChallenge(pending.id);
      if (challenge) {
        userId = await finishAuthentication(
          credential,
          challenge,
          config,
          pending.userId,
        );
      }
      if (!userId) {
        recordPendingFailure(pending);
        return invalid();
      }
      release();
      deletePendingLogin(pending.id);
      deletePendingCookie(cookies);
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return json({ message: err.message }, { status: 429 });
    }
    throw err;
  }

  const result = issueLogin(userId);
  if (locals.session) invalidateSession(locals.session.id);
  setSessionCookie(cookies, result.token, result.session.expiresAt);
  return json({ redirectTo: safeRedirectTo(body.redirectTo) });
};
