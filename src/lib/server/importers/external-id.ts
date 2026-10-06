import { createHash } from "node:crypto";
import type { NormalizedTransaction } from "./types";

/** A parsed booking with the id it would get on its own, before duplicates are told apart. */
export interface Draft {
  tx: Omit<NormalizedTransaction, "externalId">;
  baseId: string;
  legacyBaseId: string | null;
}

export function sha256(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The IBAN, else a short hash of the case- and spacing-normalised name, else null. */
export function counterpartyKey(cp: {
  name: string | null;
  iban: string | null;
}): string | null {
  if (cp.iban) return cp.iban;
  const name = cp.name?.toLowerCase().replace(/\s+/g, " ").trim();
  return name ? `n-${sha256([name]).slice(0, 16)}` : null;
}

/**
 * Identical ids within one statement (e.g. two identical bookings on the same day) get an
 * occurrence suffix `#2`, `#3`, ... in file order, so real duplicates are kept apart yet
 * remain stable as long as overlapping files contain the same identical bookings.
 *
 * `legacyExternalIds` holds the ids earlier versions derived (NtryRef-based or the older,
 * smaller hash) so already imported rows are still recognised as duplicates.
 */
export function assignExternalIds(drafts: Draft[]): NormalizedTransaction[] {
  const seen = new Map<string, number>();
  const occurrence = (id: string, scope: string): string => {
    const key = `${scope}|${id}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? id : `${id}#${count}`;
  };
  return drafts.map(({ tx, baseId, legacyBaseId }) => {
    const externalId = occurrence(baseId, "id");
    if (legacyBaseId === null) return { ...tx, externalId };
    return {
      ...tx,
      externalId,
      legacyExternalIds: [occurrence(legacyBaseId, "legacy")],
    };
  });
}
