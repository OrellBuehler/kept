import { json } from "@sveltejs/kit";
import { hasRecentReauth } from "$lib/server/auth/two-factor";
import { createWebauthnChallenge } from "$lib/server/auth/challenges";
import { requireUser } from "$lib/server/auth/guards";
import { readJsonBody } from "$lib/server/auth/http";
import { beginRegistration, webauthnConfig } from "$lib/server/auth/passkeys";
import { z } from "zod";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals);
  if (!hasRecentReauth(locals.session?.id)) {
    return json(
      { message: "Confirm your password first.", code: "reauth_required" },
      { status: 403 },
    );
  }
  await readJsonBody(request, url, z.object({}));
  const options = await beginRegistration(user, webauthnConfig(url));
  const challengeId = createWebauthnChallenge(
    "passkey_register",
    user.id,
    options.challenge,
  );
  return json({ options, challengeId });
};
