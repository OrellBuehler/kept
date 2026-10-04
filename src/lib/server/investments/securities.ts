import { and, asc, eq } from "drizzle-orm";
import type { SecurityKind } from "$lib/investment-types";
import { getDB, securities, securityPrices, trades } from "$lib/server/db";
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

const columns = {
  id: securities.id,
  name: securities.name,
  kind: securities.kind,
  isin: securities.isin,
  symbol: securities.symbol,
  currency: securities.currency,
};

export function listSecurities(userId: string): SecurityView[] {
  return getDB()
    .select(columns)
    .from(securities)
    .where(eq(securities.userId, userId))
    .orderBy(asc(securities.name), asc(securities.id))
    .all();
}

export function getSecurity(userId: string, id: string): SecurityView {
  const row = getDB()
    .select(columns)
    .from(securities)
    .where(and(eq(securities.userId, userId), eq(securities.id, id)))
    .get();
  if (!row) throw notFound("Security");
  return row;
}

export function createSecurity(
  userId: string,
  input: SecurityInput,
): SecurityView {
  const row = getDB()
    .insert(securities)
    .values({ ...input, userId })
    .returning({ id: securities.id })
    .get();
  return getSecurity(userId, row.id);
}

export function updateSecurity(
  userId: string,
  id: string,
  input: SecurityInput,
): SecurityView {
  const current = getSecurity(userId, id);
  const db = getDB();
  const currencyChanged = input.currency !== current.currency;
  const symbolChanged = input.symbol !== current.symbol;

  if (currencyChanged) {
    const used = db
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.userId, userId), eq(trades.securityId, id)))
      .get();
    if (used) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the security has trades.",
        "currency",
      );
    }
    const manual = db
      .select({ id: securityPrices.id })
      .from(securityPrices)
      .where(
        and(
          eq(securityPrices.securityId, id),
          eq(securityPrices.source, "manual"),
        ),
      )
      .get();
    if (manual) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the security has manual prices. Delete them first.",
        "currency",
      );
    }
  }

  db.transaction((tx) => {
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
  });
  return getSecurity(userId, id);
}

/** Blocked while trades reference the security; its prices go with it. */
export function deleteSecurity(userId: string, id: string): void {
  getSecurity(userId, id);
  const used = getDB()
    .select({ id: trades.id })
    .from(trades)
    .where(and(eq(trades.userId, userId), eq(trades.securityId, id)))
    .get();
  if (used) {
    throw new LedgerError(
      "conflict",
      "The security cannot be deleted while it has trades.",
    );
  }
  getDB()
    .delete(securities)
    .where(and(eq(securities.userId, userId), eq(securities.id, id)))
    .run();
}
