import { plural } from "$lib/import-ui";

export interface TransferOutcome {
  linked: number;
  mirrored: number;
  needsAmount: number;
}

/** One line for a toast: what linking transfers did. Null when nothing happened. */
export function transferSummary(outcome: TransferOutcome): string | null {
  const parts: string[] = [];
  if (outcome.linked > 0)
    parts.push(`${plural(outcome.linked, "transfer")} linked`);
  if (outcome.mirrored > 0)
    parts.push(`${plural(outcome.mirrored, "transaction")} filled in`);
  if (outcome.needsAmount > 0)
    parts.push(
      `${plural(outcome.needsAmount, "transfer")} ${outcome.needsAmount === 1 ? "needs" : "need"} an amount`,
    );
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Reads the `linked`, `mirrored` and `needsAmount` counts the import redirect adds. */
export function outcomeFromParams(
  params: Pick<URLSearchParams, "get">,
): TransferOutcome {
  const count = (key: string) => {
    const n = Number(params.get(key));
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  return {
    linked: count("linked"),
    mirrored: count("mirrored"),
    needsAmount: count("needsAmount"),
  };
}
