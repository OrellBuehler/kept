import { and, eq, isNotNull } from "drizzle-orm";
import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
import { getDB, portfolios } from "$lib/server/db";
import { matchReference } from "./reference-match";

/**
 * Normalized deposit references of the user's portfolios. Used to treat
 * outgoing payments carrying one of them as internal transfers.
 */
export async function portfolioDepositReferences(
  userId: string,
): Promise<Set<string>> {
  return new Set(
    (
      await getDB()
        .select({ reference: portfolios.depositReference })
        .from(portfolios)
        .where(
          and(
            eq(portfolios.userId, userId),
            isNotNull(portfolios.depositReference),
          ),
        )
    ).map((r) => r.reference!),
  );
}

/** An outgoing CHF payment that carries a portfolio's deposit reference is a 3a contribution. */
export function isContributionPayment(
  references: ReadonlySet<string>,
  tx: { amount: number; currency: string; reference: string | null },
): boolean {
  return (
    references.size > 0 &&
    tx.amount < 0 &&
    tx.currency === PILLAR_3A_CURRENCY &&
    tx.reference !== null &&
    references.has(matchReference(tx.reference))
  );
}
