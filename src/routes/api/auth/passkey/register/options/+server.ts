import { json } from "@sveltejs/kit";
import { createWebauthnChallenge } from "$lib/server/auth/challenges";
import { requireUser } from "$lib/server/auth/guards";
import { readJsonBody } from "$lib/server/auth/http";
import { beginRegistration, webauthnConfig } from "$lib/server/auth/passkeys";
import { z } from "zod";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals);
  await readJsonBody(request, url, z.object({}));
  const options = await beginRegistration(user, webauthnConfig(url));
  const challengeId = createWebauthnChallenge(
    "passkey_register",
    user.id,
    options.challenge,
  );
  return json({ options, challengeId });
};
