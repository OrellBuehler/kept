import { json } from "@sveltejs/kit";
import { z } from "zod";
import { createWebauthnChallenge } from "$lib/server/auth/challenges";
import { requireUser } from "$lib/server/auth/guards";
import { readJsonBody } from "$lib/server/auth/http";
import { beginAuthentication, webauthnConfig } from "$lib/server/auth/passkeys";
import { getTwoFactorStatus } from "$lib/server/auth/two-factor";
import type { RequestHandler } from "./$types";

/** Step-up for passkey-only users: a fresh assertion from one of the caller's own passkeys. */
export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals);
  await readJsonBody(request, url, z.object({}));
  if (getTwoFactorStatus(user.id).totpEnabled) {
    return json({ message: "Use your authenticator code." }, { status: 400 });
  }
  if (getTwoFactorStatus(user.id).passkeyCount === 0) {
    return json({ message: "No passkeys registered." }, { status: 400 });
  }
  const options = await beginAuthentication(user.id, webauthnConfig(url));
  const challengeId = createWebauthnChallenge(
    "passkey_stepup",
    user.id,
    options.challenge,
  );
  return json({ options, challengeId });
};
