import type { z } from "zod";
import { LedgerError } from "$lib/server/ledger/errors";

/**
 * Parses with a service's own Zod schema and turns a refusal into the
 * `LedgerError` the tool wrapper reports to the model (`Invalid creditorName: …`).
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  throw new LedgerError(
    "invalid",
    field ? `Invalid ${field}: ${issue?.message}` : `${issue?.message}`,
    field || undefined,
  );
}
