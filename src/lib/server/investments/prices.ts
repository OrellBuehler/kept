import { and, count, desc, eq, sql } from "drizzle-orm";
import type { PriceSource } from "$lib/investment-types";
import type { Fixed8 } from "$lib/quantity";
import { fxRates, getDB, securities, securityPrices } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { PriceInput } from "./schemas";

export interface PriceView {
  id: string;
  securityId: string;
  date: string;
  price: Fixed8;
  source: PriceSource;
}

export interface PriceRow {
  date: string;
  price: Fixed8;
}

export interface FxRateRow {
  base: string;
  quote: string;
  date: string;
  rate: Fixed8;
}

const columns = {
  id: securityPrices.id,
  securityId: securityPrices.securityId,
  date: securityPrices.date,
  price: securityPrices.price,
  source: securityPrices.source,
};

/** Rows per insert statement, well below SQLite's bound-parameter limit. */
const CHUNK = 500;

function assertSecurity(userId: string, securityId: string) {
  const found = getDB()
    .select({ id: securities.id })
    .from(securities)
    .where(and(eq(securities.userId, userId), eq(securities.id, securityId)))
    .get();
  if (!found) throw notFound("Security");
}

/** Rows `listPrices` returns unless asked for more. */
export const PRICE_LIST_LIMIT = 365;

export function countPrices(userId: string, securityId: string): number {
  assertSecurity(userId, securityId);
  return getDB()
    .select({ n: count() })
    .from(securityPrices)
    .where(
      and(
        eq(securityPrices.userId, userId),
        eq(securityPrices.securityId, securityId),
      ),
    )
    .get()!.n;
}

/** Newest first, at most `limit` rows; a manual and a fetched price may share a date. */
export function listPrices(
  userId: string,
  securityId: string,
  limit: number = PRICE_LIST_LIMIT,
): PriceView[] {
  assertSecurity(userId, securityId);
  return getDB()
    .select(columns)
    .from(securityPrices)
    .where(
      and(
        eq(securityPrices.userId, userId),
        eq(securityPrices.securityId, securityId),
      ),
    )
    .orderBy(desc(securityPrices.date), desc(securityPrices.source))
    .limit(limit)
    .all();
}

function getPrice(userId: string, id: string): PriceView {
  const row = getDB()
    .select(columns)
    .from(securityPrices)
    .where(and(eq(securityPrices.userId, userId), eq(securityPrices.id, id)))
    .get();
  if (!row) throw notFound("Price");
  return row;
}

/** Sets or replaces the manual price of a date; it wins over a fetched one. */
export function setManualPrice(
  userId: string,
  securityId: string,
  input: PriceInput,
): PriceView {
  assertSecurity(userId, securityId);
  const row = getDB()
    .insert(securityPrices)
    .values({ userId, securityId, ...input, source: "manual" })
    .onConflictDoUpdate({
      target: [
        securityPrices.securityId,
        securityPrices.date,
        securityPrices.source,
      ],
      set: { price: input.price, updatedAt: new Date() },
    })
    .returning({ id: securityPrices.id })
    .get();
  return getPrice(userId, row.id);
}

/** Manual prices only; fetched ones are managed by the market data refresh. */
export function deletePrice(userId: string, id: string): void {
  const current = getPrice(userId, id);
  if (current.source !== "manual") {
    throw new LedgerError("conflict", "Fetched prices cannot be deleted.");
  }
  getDB()
    .delete(securityPrices)
    .where(and(eq(securityPrices.userId, userId), eq(securityPrices.id, id)))
    .run();
}

/** Rows with a price of zero or less are provider noise and are skipped. */
export function upsertProviderPrices(
  userId: string,
  securityId: string,
  allRows: readonly PriceRow[],
): number {
  assertSecurity(userId, securityId);
  const rows = allRows.filter((r) => r.price > 0);
  const db = getDB();
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx.insert(securityPrices)
        .values(
          rows.slice(i, i + CHUNK).map((r) => ({
            userId,
            securityId,
            date: r.date,
            price: r.price,
            source: "provider" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [
            securityPrices.securityId,
            securityPrices.date,
            securityPrices.source,
          ],
          set: {
            price: sql`excluded.price`,
            updatedAt: new Date(),
          },
        })
        .run();
    }
  });
  return rows.length;
}

export function upsertFxRates(
  userId: string,
  rows: readonly FxRateRow[],
): number {
  const db = getDB();
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx.insert(fxRates)
        .values(
          rows.slice(i, i + CHUNK).map((r) => ({
            userId,
            base: r.base,
            quote: r.quote,
            date: r.date,
            rate: r.rate,
            source: "provider" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [
            fxRates.userId,
            fxRates.base,
            fxRates.quote,
            fxRates.date,
            fxRates.source,
          ],
          set: { rate: sql`excluded.rate`, updatedAt: new Date() },
        })
        .run();
    }
  });
  return rows.length;
}
