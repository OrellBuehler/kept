import { and, asc, eq } from "drizzle-orm";
import type { SecurityKind } from "$lib/investment-types";
import {
  type DB,
  first,
  getDB,
  securities,
  securityPrices,
  trades,
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
 * The checks and the writes share one transaction, so a trade or a manual
 * price added in between cannot slip past the currency guard.
 */
function updateSecurityInTx(
  tx: Tx,
  userId: string,
  id: string,
  input: SecurityInput,
) {
  const current = tx
    .select(columns)
    .from(securities)
    .where(and(eq(securities.userId, userId), eq(securities.id, id)))
    .limit(1)
    .get();
  if (!current) throw notFound("Security");
  const currencyChanged = input.currency !== current.currency;
  const symbolChanged = input.symbol !== current.symbol;

  if (currencyChanged) {
    const used = tx
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.userId, userId), eq(trades.securityId, id)))
      .limit(1)
      .get();
    if (used) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the security has trades.",
        "currency",
      );
    }
    const manual = tx
      .select({ id: securityPrices.id })
      .from(securityPrices)
      .where(
        and(
          eq(securityPrices.securityId, id),
          eq(securityPrices.source, "manual"),
        ),
      )
      .limit(1)
      .get();
    if (manual) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the security has manual prices. Delete them first.",
        "currency",
      );
    }
  }

  tx.update(securities)
    .set(input)
    .where(and(eq(securities.userId, userId), eq(securities.id, id)))
    .run();
  if (currencyChanged || symbolChanged) {
    tx.delete(securityPrices)
      .where(
        and(
          eq(securityPrices.securityId, id),
          eq(securityPrices.source, "provider"),
        ),
      )
      .run();
  }
}

export async function updateSecurity(
  userId: string,
  id: string,
  input: SecurityInput,
): Promise<SecurityView> {
  getDB().transaction((tx) => updateSecurityInTx(tx, userId, id, input));
  return await getSecurity(userId, id);
}

/** Blocked while trades reference the security; its prices go with it. */
export async function deleteSecurity(
  userId: string,
  id: string,
): Promise<void> {
  getDB().transaction((tx) => {
    const found = tx
      .select({ id: securities.id })
      .from(securities)
      .where(and(eq(securities.userId, userId), eq(securities.id, id)))
      .limit(1)
      .get();
    if (!found) throw notFound("Security");
    const used = tx
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.userId, userId), eq(trades.securityId, id)))
      .limit(1)
      .get();
    if (used) {
      throw new LedgerError(
        "conflict",
        "The security cannot be deleted while it has trades.",
      );
    }
    tx.delete(securities)
      .where(and(eq(securities.userId, userId), eq(securities.id, id)))
      .run();
  });
}
