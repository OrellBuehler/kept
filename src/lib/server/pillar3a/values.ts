import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { Minor } from "$lib/money";
import { returnBps } from "$lib/pillar-3a";
import {
  accounts,
  first,
  getDB,
  portfolios,
  portfolioValues,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { ledgerLock } from "$lib/server/ledger/lock";
import type { PortfolioValueEntry } from "./schemas";

export interface PortfolioValueView {
  id: string;
  portfolioId: string;
  date: string;
  amount: Minor;
  /** Total gain as reported by the provider on that date. */
  gain: Minor | null;
  /** Total return as reported by the provider, in hundredths of a percent. */
  gainBps: number | null;
  note: string | null;
}

const columns = {
  id: portfolioValues.id,
  portfolioId: portfolioValues.portfolioId,
  date: portfolioValues.date,
  amount: portfolioValues.amount,
  gain: portfolioValues.gain,
  gainBps: portfolioValues.gainBps,
  note: portfolioValues.note,
};

/**
 * Batch entry: the value of several portfolios of one account on `date`
 * ("update everything today"). Each (portfolio, date) is upserted; a gain
 * or return that is null is cleared, one that is undefined keeps what the date
 * already has. Every
 * portfolio must belong to the account, and a closed portfolio takes no value
 * on or after its closing date.
 */
export async function setValues(
  userId: string,
  accountId: string,
  date: string,
  entries: readonly PortfolioValueEntry[],
  note: string | null = null,
): Promise<PortfolioValueView[]> {
  const ids = entries.map((e) => e.portfolioId);
  const db = getDB();
  // The checks and the upserts are one unit under the ledger lock, which
  // closing, reopening and deleting a portfolio take too: none of them can
  // run between validating the entry and writing it.
  await transaction(
    async (tx) => {
      const account = await first(
        tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
          .limit(1),
      );
      if (!account) throw notFound("Account");
      if (entries.length === 0) {
        throw new LedgerError("invalid", "Enter at least one value.");
      }
      if (new Set(ids).size !== ids.length) {
        throw new LedgerError(
          "invalid",
          "Each portfolio can only be listed once.",
        );
      }
      const owned = new Map(
        (
          await tx
            .select({ id: portfolios.id, closedOn: portfolios.closedOn })
            .from(portfolios)
            .where(
              and(
                eq(portfolios.userId, userId),
                eq(portfolios.accountId, accountId),
                inArray(portfolios.id, ids),
              ),
            )
        ).map((p) => [p.id, p.closedOn]),
      );
      for (const e of entries) {
        if (!owned.has(e.portfolioId)) throw notFound("Portfolio");
        if (e.amount < 0) {
          throw new LedgerError("invalid", "The value must not be negative.");
        }
        const closedOn = owned.get(e.portfolioId) ?? null;
        if (closedOn !== null && date >= closedOn) {
          throw new LedgerError(
            "invalid",
            "A closed portfolio takes no value on or after its closing date.",
            "date",
          );
        }
      }
      for (const e of entries) {
        await tx
          .insert(portfolioValues)
          .values({
            userId,
            portfolioId: e.portfolioId,
            date,
            amount: e.amount,
            gain: e.gain ?? null,
            gainBps: e.gainBps ?? null,
            note,
          })
          .onConflictDoUpdate({
            target: [portfolioValues.portfolioId, portfolioValues.date],
            set: {
              amount: e.amount,
              ...(e.gain !== undefined && { gain: e.gain }),
              ...(e.gainBps !== undefined && { gainBps: e.gainBps }),
              note,
              updatedAt: new Date(),
            },
          });
      }
    },
    { lock: ledgerLock(userId) },
  );
  return await db
    .select(columns)
    .from(portfolioValues)
    .where(
      and(
        eq(portfolioValues.userId, userId),
        eq(portfolioValues.date, date),
        inArray(portfolioValues.portfolioId, ids),
      ),
    );
}

/** Value history of one portfolio, newest first. */
export async function listValues(
  userId: string,
  portfolioId: string,
): Promise<PortfolioValueView[]> {
  const owned = await first(
    getDB()
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, portfolioId)))
      .limit(1),
  );
  if (!owned) throw notFound("Portfolio");
  return await getDB()
    .select(columns)
    .from(portfolioValues)
    .where(
      and(
        eq(portfolioValues.userId, userId),
        eq(portfolioValues.portfolioId, portfolioId),
      ),
    )
    .orderBy(desc(portfolioValues.date));
}

export async function deleteValue(userId: string, id: string): Promise<void> {
  const deleted = await getDB()
    .delete(portfolioValues)
    .where(and(eq(portfolioValues.userId, userId), eq(portfolioValues.id, id)))
    .returning({ id: portfolioValues.id });
  if (deleted.length === 0) throw notFound("Value");
}

export interface PortfolioPerformancePoint {
  date: string;
  amount: Minor;
  gain: Minor | null;
  /** Total return in hundredths of a percent: as reported, or derived from the gain. */
  gainBps: number;
}

export interface PortfolioPerformance {
  portfolioId: string;
  /** Oldest first: the values up to `today` that carry a gain or a return. */
  points: PortfolioPerformancePoint[];
}

/**
 * The reported performance of the user's portfolios over time, for comparing
 * them. Portfolios without a reported gain are left out.
 */
export async function portfolioPerformance(
  userId: string,
  today: string,
): Promise<PortfolioPerformance[]> {
  const byPortfolio = new Map<string, PortfolioPerformancePoint[]>();
  for (const v of await getDB()
    .select(columns)
    .from(portfolioValues)
    .where(
      and(eq(portfolioValues.userId, userId), lte(portfolioValues.date, today)),
    )
    .orderBy(asc(portfolioValues.date), asc(portfolioValues.id))) {
    const gainBps = returnBps(v);
    if (gainBps === null) continue;
    let points = byPortfolio.get(v.portfolioId);
    if (!points) {
      points = [];
      byPortfolio.set(v.portfolioId, points);
    }
    points.push({ date: v.date, amount: v.amount, gain: v.gain, gainBps });
  }
  return [...byPortfolio]
    .map(([portfolioId, points]) => ({ portfolioId, points }))
    .sort((a, b) => a.portfolioId.localeCompare(b.portfolioId));
}
