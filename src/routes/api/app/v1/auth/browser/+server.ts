import { json } from "@sveltejs/kit";
import { APP_SIGN_IN_PATH } from "$lib/server/app-api/sign-in";
import { createAppSignIn } from "$lib/server/auth/challenges";
import { clientKey } from "$lib/server/auth/login";
import { appSignInLimiter } from "$lib/server/auth/rate-limit";
import { tooManyRequests } from "$lib/server/external-api/gate";
import type { RequestHandler } from "./$types";

/**
 * Starts a sign-in through the browser, for what the app's own form cannot do
 * (passkeys, a password manager that fills by web address). The app opens
 * `path` on this server in a browser, the user signs in there and approves,
 * and the browser returns to the app with a one-time code. The app trades
 * `request`, `secret` and that code for a session at `auth/browser/token`.
 * `secret` never leaves the app, and the code only reaches the device the
 * approval happened on: neither alone is worth anything.
 */
export const POST: RequestHandler = async ({ getClientAddress }) => {
  const gate = appSignInLimiter.acquire("start", clientKey(getClientAddress));
  if (!gate.allowed) {
    return tooManyRequests(
      gate.retryAfterMs,
      `Too many attempts, try again in ${gate.retryAfterMinutes} minutes.`,
    );
  }
  const started = await createAppSignIn();
  return json({
    request: started.request,
    secret: started.secret,
    path: `${APP_SIGN_IN_PATH}?request=${encodeURIComponent(started.request)}`,
    expiresAt: started.expiresAt.toISOString(),
  });
};
