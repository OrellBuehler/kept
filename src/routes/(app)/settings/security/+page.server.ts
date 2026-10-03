import { fail } from "@sveltejs/kit";
import QRCode from "qrcode";
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
  totpConfirmSchema,
  twoFactorReauthSchema,
} from "$lib/server/auth/schemas";
import {
  cancelTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  getPendingTotpEnrolment,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { AuthError } from "$lib/server/auth/types";
import { parseForm } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const pending = getPendingTotpEnrolment(user.id, user.username);
  return {
    status: getTwoFactorStatus(user.id),
    passkeys: listPasskeys(user.id),
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
  startTotp: ({ locals }) => {
    const user = requireUser(locals);
    try {
      startTotpEnrolment(user.id, user.username);
    } catch (err) {
      return reauthFailure(err);
    }
    return { started: true as const };
  },

  cancelTotp: ({ locals }) => {
    cancelTotpEnrolment(requireUser(locals).id);
    return { cancelled: true as const };
  },

  confirmTotp: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(totpConfirmSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      const recoveryCodes = confirmTotpEnrolment(user.id, parsed.data.code);
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

  renamePasskey: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(renamePasskeySchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      renamePasskey(user.id, parsed.data.id, parsed.data.name);
    } catch (err) {
      return reauthFailure(err);
    }
    return { renamed: true as const };
  },

  deletePasskey: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(passkeyIdSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      deletePasskey(user.id, parsed.data.id);
    } catch (err) {
      return reauthFailure(err);
    }
    return { deleted: true as const };
  },
};
