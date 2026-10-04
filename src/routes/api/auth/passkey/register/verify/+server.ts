import { json } from "@sveltejs/kit";
import { hasRecentReauth } from "$lib/server/auth/two-factor";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { takeWebauthnChallenge } from "$lib/server/auth/challenges";
import { requireUser } from "$lib/server/auth/guards";
import { readJsonBody } from "$lib/server/auth/http";
import { finishRegistration, webauthnConfig } from "$lib/server/auth/passkeys";
import { passkeyRegisterVerifySchema } from "$lib/server/auth/schemas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals);
  if (!(await hasRecentReauth(locals.session?.id))) {
    return json(
      { message: "Confirm your password first.", code: "reauth_required" },
      { status: 403 },
    );
  }
  const body = await readJsonBody(request, url, passkeyRegisterVerifySchema);
  const challenge = await takeWebauthnChallenge(
    body.challengeId,
    "passkey_register",
    user.id,
  );
  if (!challenge) {
    return json(
      { message: "The registration expired. Please try again." },
      { status: 400 },
    );
  }
  const passkey = await finishRegistration(
    user.id,
    body.name,
    body.credential as unknown as RegistrationResponseJSON,
    challenge,
    webauthnConfig(url),
  );
  if (!passkey) {
    return json(
      { message: "The passkey could not be verified." },
      { status: 400 },
    );
  }
  return json({ passkey }, { status: 201 });
};
