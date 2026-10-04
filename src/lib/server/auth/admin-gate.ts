import { fail } from "@sveltejs/kit";
import { confirmAdmin } from "./admin-confirm";
import {
  recordAdminAction,
  recordConfirmationRateLimited,
} from "./admin-audit";
import { RateLimitedError } from "./rate-limit";
import { AuthError } from "./types";

/**
 * Null when the administrator is confirmed; otherwise the failure to return from the action.
 * Failed confirmations and rate-limit hits are written to the admin audit log.
 */
export async function adminConfirmationFailure(
  admin: { id: string; username: string },
  sessionId: string | undefined,
  input: { password: string; code?: string },
  values?: Record<string, string>,
) {
  try {
    await confirmAdmin(admin.id, sessionId, input);
    return null;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      await recordConfirmationRateLimited(admin);
      return fail(429, { errors: { form: [err.message] }, values });
    }
    if (err instanceof AuthError) {
      if (err.code === "invalid_credentials") {
        await recordAdminAction(admin, "admin_confirm_failed", {
          details: "reason=password",
        });
        return fail(400, {
          errors: { adminPassword: ["Your password is incorrect."] },
          values,
        });
      }
      if (err.code === "invalid_code") {
        await recordAdminAction(admin, "admin_confirm_failed", {
          details: "reason=code",
        });
        return fail(400, {
          errors: { adminCode: ["That code is not valid."] },
          values,
        });
      }
      if (err.code === "passkey_required") {
        return fail(400, { errors: { form: [err.message] }, values });
      }
    }
    throw err;
  }
}
