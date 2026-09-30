export type LedgerErrorCode = "not_found" | "conflict" | "invalid";

/**
 * Expected, user-facing failure of a ledger operation. `field` names the form
 * field the message belongs to, when there is one.
 */
export class LedgerError extends Error {
  override name = "LedgerError";
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) =>
  new LedgerError("not_found", `${what} not found.`);
