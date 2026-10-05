import { and, asc, eq } from "drizzle-orm";
import type { SecurityKind } from "$lib/investment-types";
import {
  type DB,
  first,
  getDB,
  securities,
  securityPrices,
  trades,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { SecurityInput } from "./schemas";

export interface SecurityView {
  id: string;
  name: string;
  kind: SecurityKind;
  isin: string | null;
  symbol: string | null;
  currency: string;
}

type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;

const columns = {
  id: securities.id,
  name: securities.name,
  kind: securities.kind,
  isin: securities.isin,
  symbol: securities.symbol,
  currency: securities.currency,
};

export async function listSecurities(userId: string): Promise<SecurityView[]> {
  return await getDB()
    .select(columns)
    .from(securities)
    .where(eq(securities.userId, userId))
    .orderBy(asc(securities.name), asc(securities.id));
}

export async function getSecurity(
  userId: string,
  id: string,
): Promise<SecurityView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(securities)
      .where(and(eq(securities.userId, userId), eq(securities.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Security");
  return row;
}

export async function createSecurity(
  userId: string,
  input: SecurityInput,
): Promise<SecurityView> {
  const row = (
    await getDB()
      .insert(securities)
      .values({ ...input, userId })
      .returning({ id: securities.id })
  )[0]!;
  return await getSecurity(userId, row.id);
}

/**
 * What trades and manual prices rely on about a security (its currency, that
 * it exists) is checked in their own transactions, so changing or deleting the
 * security takes the same lock as adding a trade or a price. Under PostgreSQL
 * a transaction does not see a concurrent one's uncommitted rows.
 */
export const securityLock = (userId: string) => `trades:${userId}`;

/**
 * The checks and the writes share one transaction (and the security lock), so a
 * trade or a manual price added in between cannot slip past the currency guard.
 */
async function updateSecurityInTx(
  tx: Tx,
  userId: string,
  id: string,
  input: SecurityInput,
) {
  const current = await first(
    tx
      .select(columns)
      .from(securities)
      .where(and(eq(securities.userId, userId), eq(securities.id, id)))
      .limit(1),
  );
  if (!current) throw notFound("Security");
  const currencyChanged = input.currency !== current.currency;
  const symbolChanged = input.symbol !== current.symbol;

  if (currencyChanged) {
    const used = await first(
      tx
        .select({ id: trades.id })
        .from(trades)
        .where(and(eq(trades.userId, userId), eq(trades.securityId, id)))
        .limit(1),
    );
    if (used) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the security has trades.",
        "currency",
      );
    }
    const manual = await first(
      tx
        .select({ id: securityPrices.id })
        .from(securityPrices)
        .where(
          and(
            eq(securityPrices.securityId, id),
            eq(securityPrices.source, "manual"),
          ),
        )
        .limit(1),
    );
    if (manual) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the security has manual prices. Delete them first.",
        "currency",
      );
    }
  }

  await tx
    .update(securities)
    .set(input)
    .where(and(eq(securities.userId, userId), eq(securities.id, id)));
  if (currencyChanged || symbolChanged) {
    await tx
      .delete(securityPrices)
      .where(
        and(
          eq(securityPrices.securityId, id),
          eq(securityPrices.source, "provider"),
        ),
      );
  }
}

export async function updateSecurity(
  userId: string,
  id: string,
  input: SecurityInput,
): Promise<SecurityView> {
  await transaction(async (tx) => updateSecurityInTx(tx, userId, id, input), {
    lock: securityLock(userId),
  });
  return await getSecurity(userId, id);
}

/** Blocked while trades reference the security; its prices go with it. */
export async function deleteSecurity(
  userId: string,
  id: string,
): Promise<void> {
  await transaction(
    async (tx) => {
      const found = await first(
        tx
          .select({ id: securities.id })
          .from(securities)
          .where(and(eq(securities.userId, userId), eq(securities.id, id)))
          .limit(1),
      );
      if (!found) throw notFound("Security");
      const used = await first(
        tx
          .select({ id: trades.id })
          .from(trades)
          .where(and(eq(trades.userId, userId), eq(trades.securityId, id)))
          .limit(1),
      );
      if (used) {
        throw new LedgerError(
          "conflict",
          "The security cannot be deleted while it has trades.",
        );
      }
      await tx
        .delete(securities)
        .where(and(eq(securities.userId, userId), eq(securities.id, id)));
    },
    { lock: securityLock(userId) },
  );
}
