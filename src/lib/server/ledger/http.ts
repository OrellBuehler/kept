import { error, fail } from "@sveltejs/kit";
import { LedgerError } from "./errors";

/**
 * Maps a ledger error to an HTTP outcome for a form action: 404 for ids that
 * do not exist for this user, otherwise a 400 failure keyed by form field.
 * Anything unexpected is rethrown.
 */
export function ledgerFailure(
  action: string,
  err: unknown,
  values: Record<string, string> = {},
) {
  if (err instanceof LedgerError) {
    if (err.code === "not_found") error(404, err.message);
    return fail(400, {
      action,
      errors: { [err.field ?? "form"]: [err.message] },
      values,
    });
  }
  throw err;
}

/** For loads: a missing or foreign id is a 404. */
export async function orNotFoundAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LedgerError && err.code === "not_found") {
      error(404, err.message);
    }
    throw err;
  }
}
