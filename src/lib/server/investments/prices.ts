import { and, count, desc, eq, sql } from "drizzle-orm";
import type { PriceSource } from "$lib/investment-types";
import type { Fixed8 } from "$lib/quantity";
import {
  type DB,
  first,
  fxRates,
  getDB,
  securities,
  securityPrices,
  transaction,
} from "$lib/server/db";
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

type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;

async function assertSecurityInTx(tx: Tx, userId: string, securityId: string) {
  const found = await first(
    tx
      .select({ id: securities.id })
      .from(securities)
      .where(and(eq(securities.userId, userId), eq(securities.id, securityId)))
      .limit(1),
  );
  if (!found) throw notFound("Security");
}

async function assertSecurity(userId: string, securityId: string) {
  const found = await first(
    getDB()
      .select({ id: securities.id })
      .from(securities)
      .where(and(eq(securities.userId, userId), eq(securities.id, securityId)))
      .limit(1),
  );
  if (!found) throw notFound("Security");
}

/** Rows `listPrices` returns unless asked for more. */
export const PRICE_LIST_LIMIT = 365;

export async function countPrices(
  userId: string,
  securityId: string,
): Promise<number> {
  await assertSecurity(userId, securityId);
  return (
    await getDB()
      .select({ n: count() })
      .from(securityPrices)
      .where(
        and(
          eq(securityPrices.userId, userId),
          eq(securityPrices.securityId, securityId),
        ),
      )
  )[0]!.n;
}

/** Newest first, at most `limit` rows; a manual and a fetched price may share a date. */
export async function listPrices(
  userId: string,
  securityId: string,
  limit: number = PRICE_LIST_LIMIT,
): Promise<PriceView[]> {
  await assertSecurity(userId, securityId);
  return await getDB()
    .select(columns)
    .from(securityPrices)
    .where(
      and(
        eq(securityPrices.userId, userId),
        eq(securityPrices.securityId, securityId),
      ),
    )
    .orderBy(desc(securityPrices.date), desc(securityPrices.source))
    .limit(limit);
}

async function getPrice(userId: string, id: string): Promise<PriceView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(securityPrices)
      .where(and(eq(securityPrices.userId, userId), eq(securityPrices.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Price");
  return row;
}

/** Sets or replaces the manual price of a date; it wins over a fetched one. */
export async function setManualPrice(
  userId: string,
  securityId: string,
  input: PriceInput,
): Promise<PriceView> {
  const row = await transaction(async (tx) => {
    await assertSecurityInTx(tx, userId, securityId);
    return (await first(
      tx
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
        .returning({ id: securityPrices.id }),
    ))!;
  });
  return await getPrice(userId, row.id);
}

/** Manual prices only; fetched ones are managed by the market data refresh. */
export async function deletePrice(userId: string, id: string): Promise<void> {
  const current = await getPrice(userId, id);
  if (current.source !== "manual") {
    throw new LedgerError("conflict", "Fetched prices cannot be deleted.");
  }
  const deleted = await getDB()
    .delete(securityPrices)
    .where(and(eq(securityPrices.userId, userId), eq(securityPrices.id, id)))
    .returning({ id: securityPrices.id });
  if (deleted.length === 0) throw notFound("Price");
}

/** Rows with a price of zero or less are provider noise and are skipped. */
export async function upsertProviderPrices(
  userId: string,
  securityId: string,
  allRows: readonly PriceRow[],
): Promise<number> {
  const rows = allRows.filter((r) => r.price > 0);
  await transaction(async (tx) => {
    await assertSecurityInTx(tx, userId, securityId);
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(securityPrices)
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
        });
    }
  });
  return rows.length;
}

export async function upsertFxRates(
  userId: string,
  rows: readonly FxRateRow[],
): Promise<number> {
  await transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(fxRates)
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
        });
    }
  });
  return rows.length;
}
