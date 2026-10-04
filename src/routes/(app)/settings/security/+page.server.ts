import { fail } from "@sveltejs/kit";
import QRCode from "qrcode";
import { invalidateUserSessions } from "$lib/server/auth/sessions";
import { requireUser } from "$lib/server/auth/guards";
import {
  listPasskeys,
  deletePasskey,
  renamePasskey,
} from "$lib/server/auth/passkeys";
import { RateLimitedError } from "$lib/server/auth/rate-limit";
import {
  passkeyIdSchema,
  renamePasskeySchema,
  stepUpSchema,
  totpConfirmSchema,
  totpStartSchema,
  twoFactorReauthSchema,
} from "$lib/server/auth/schemas";
import {
  cancelTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  getPendingTotpEnrolment,
  getTwoFactorStatus,
  hasRecentReauth,
  stepUpSession,
  reauthenticatePasswordOnly,
  regenerateRecoveryCodes,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { AuthError } from "$lib/server/auth/types";
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const pending = await getPendingTotpEnrolment(user.id, user.username);
  return {
    status: await getTwoFactorStatus(user.id),
    reauthed: await hasRecentReauth(locals.session?.id),
    passkeys: await listPasskeys(user.id),
    enrolment: pending
      ? {
          secret: pending.secret,
          qr: await QRCode.toDataURL(pending.uri, { margin: 1, width: 224 }),
        }
      : null,
  };
};

function reauthFailure(err: unknown) {
  if (err instanceof RateLimitedError) {
    return fail(429, { errors: { form: [err.message] } });
  }
  if (err instanceof AuthError) {
    if (err.code === "invalid_credentials") {
      return fail(400, { errors: { password: [err.message] } });
    }
    if (err.code === "invalid_code") {
      return fail(400, { errors: { code: [err.message] } });
    }
    return fail(400, { errors: { form: [err.message] } });
  }
  throw err;
}

export const actions: Actions = {
  startTotp: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(totpStartSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await reauthenticatePasswordOnly(user.id, parsed.data.password);
      await startTotpEnrolment(user.id, user.username);
    } catch (err) {
      return reauthFailure(err);
    }
    return { started: true as const };
  },

  cancelTotp: async ({ locals }) => {
    await cancelTotpEnrolment(requireUser(locals).id);
    return { cancelled: true as const };
  },

  confirmTotp: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(totpConfirmSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await reauthenticatePasswordOnly(user.id, parsed.data.password);
      const recoveryCodes = await confirmTotpEnrolment(
        user.id,
        parsed.data.code,
      );
      return { recoveryCodes };
    } catch (err) {
      return reauthFailure(err);
    }
  },

  disableTotp: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(twoFactorReauthSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await disableTotp(user.id, parsed.data.password, parsed.data.code);
      await invalidateUserSessions(user.id, locals.session?.id);
    } catch (err) {
      return reauthFailure(err);
    }
    return { disabled: true as const };
  },

  regenerateRecoveryCodes: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(twoFactorReauthSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      const recoveryCodes = await regenerateRecoveryCodes(
        user.id,
        parsed.data.password,
        parsed.data.code,
      );
      return { recoveryCodes };
    } catch (err) {
      return reauthFailure(err);
    }
  },

  stepUp: async ({ locals, request }) => {
    const user = requireUser(locals);
    if (!locals.session)
      return fail(401, { errors: { form: ["No session."] } });
    const parsed = parseForm(stepUpSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await stepUpSession(
        user.id,
        locals.session.id,
        parsed.data.password,
        parsed.data.code,
      );
    } catch (err) {
      return reauthFailure(err);
    }
    return { reauthed: true as const };
  },

  renamePasskey: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(renamePasskeySchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await renamePasskey(user.id, parsed.data.id, parsed.data.name);
    } catch (err) {
      return reauthFailure(err);
    }
    return { renamed: true as const };
  },

  deletePasskey: async ({ locals, request }) => {
    const user = requireUser(locals);
    if (!(await hasRecentReauth(locals.session?.id))) {
      return fail(403, {
        errors: { form: ["Confirm your password before removing a passkey."] },
      });
    }
    const parsed = parseForm(passkeyIdSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      await deletePasskey(user.id, parsed.data.id);
      await invalidateUserSessions(user.id, locals.session?.id);
    } catch (err) {
      return reauthFailure(err);
    }
    return { deleted: true as const };
  },
};
