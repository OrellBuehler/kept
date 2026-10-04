import { json } from "@sveltejs/kit";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  PENDING_COOKIE,
  claimPendingAttempt,
  consumePendingLogin,
  deletePendingCookie,
  failClaimedAttempt,
  getPendingLogin,
  takePendingChallenge,
  takeWebauthnChallenge,
} from "$lib/server/auth/challenges";
import { readJsonBody } from "$lib/server/auth/http";
import {
  clientKey,
  issueLogin,
  recordLoginSuccess,
} from "$lib/server/auth/login";
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

  let userId: string;
  try {
    if (body.challengeId) {
      const release = passkeyLoginLimiter.acquireOrThrow("passkey", ip);
      const challenge = await takeWebauthnChallenge(
        body.challengeId,
        "passkey_login",
        null,
      );
      if (!challenge) return invalid();
      const found = await finishAuthentication(
        credential,
        challenge,
        config,
        null,
      );
      if (!found) return invalid();
      release();
      userId = found;
    } else {
      const pending = await getPendingLogin(cookies.get(PENDING_COOKIE));
      if (!pending) {
        deletePendingCookie(cookies);
        return json(
          { message: "Your sign-in expired. Start again." },
          { status: 401 },
        );
      }
      const release = secondFactorLimiter.acquireOrThrow(pending.userId, ip);
      const claimed = await claimPendingAttempt(pending.id);
      if (claimed === null) {
        deletePendingCookie(cookies);
        return json(
          { message: "Your sign-in expired. Start again." },
          { status: 401 },
        );
      }
      let verified: string | null = null;
      let threw = true;
      try {
        const challenge = await takePendingChallenge(pending.id);
        if (challenge) {
          verified = await finishAuthentication(
            credential,
            challenge,
            config,
            pending.userId,
          );
        }
        threw = false;
      } finally {
        if (threw) release();
      }
      if (!verified) {
        await failClaimedAttempt(pending.id, claimed);
        return invalid();
      }
      release();
      if (!(await consumePendingLogin(pending.id))) {
        deletePendingCookie(cookies);
        return json(
          { message: "Your sign-in expired. Start again." },
          { status: 401 },
        );
      }
      userId = verified;
      deletePendingCookie(cookies);
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return json({ message: err.message }, { status: 429 });
    }
    throw err;
  }

  const result = await issueLogin(userId);
  await recordLoginSuccess(userId, ip);
  if (locals.session) await invalidateSession(locals.session.id);
  setSessionCookie(cookies, result.token, result.session.expiresAt);
  return json({ redirectTo: safeRedirectTo(body.redirectTo) });
};
