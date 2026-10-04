import { and, desc, eq, inArray } from "drizzle-orm";
import type { Minor } from "$lib/money";
import { accounts, getDB, portfolios, portfolioValues } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { PortfolioValueEntry } from "./schemas";

export interface PortfolioValueView {
  id: string;
  portfolioId: string;
  date: string;
  amount: Minor;
  note: string | null;
}

const columns = {
  id: portfolioValues.id,
  portfolioId: portfolioValues.portfolioId,
  date: portfolioValues.date,
  amount: portfolioValues.amount,
  note: portfolioValues.note,
};

/**
 * Batch entry: the value of several portfolios of one account on `date`
 * ("update everything today"). Each (portfolio, date) is upserted. Every
 * portfolio must belong to the account, and a closed portfolio takes no value
 * on or after its closing date.
 */
export function setValues(
  userId: string,
  accountId: string,
  date: string,
  entries: readonly PortfolioValueEntry[],
  note: string | null = null,
): PortfolioValueView[] {
  const db = getDB();
  const account = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!account) throw notFound("Account");
  if (entries.length === 0) {
    throw new LedgerError("invalid", "Enter at least one value.");
  }
  const ids = entries.map((e) => e.portfolioId);
  if (new Set(ids).size !== ids.length) {
    throw new LedgerError("invalid", "Each portfolio can only be listed once.");
  }
  const owned = new Map(
    db
      .select({ id: portfolios.id, closedOn: portfolios.closedOn })
      .from(portfolios)
      .where(
        and(
          eq(portfolios.userId, userId),
          eq(portfolios.accountId, accountId),
          inArray(portfolios.id, ids),
        ),
      )
      .all()
      .map((p) => [p.id, p.closedOn]),
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
  db.transaction((tx) => {
    for (const e of entries) {
      tx.insert(portfolioValues)
        .values({
          userId,
          portfolioId: e.portfolioId,
          date,
          amount: e.amount,
          note,
        })
        .onConflictDoUpdate({
          target: [portfolioValues.portfolioId, portfolioValues.date],
          set: { amount: e.amount, note, updatedAt: new Date() },
        })
        .run();
    }
  });
  return db
    .select(columns)
    .from(portfolioValues)
    .where(
      and(
        eq(portfolioValues.userId, userId),
        eq(portfolioValues.date, date),
        inArray(portfolioValues.portfolioId, ids),
      ),
    )
    .all();
}

/** Value history of one portfolio, newest first. */
export function listValues(
  userId: string,
  portfolioId: string,
): PortfolioValueView[] {
  const owned = getDB()
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, portfolioId)))
    .get();
  if (!owned) throw notFound("Portfolio");
  return getDB()
    .select(columns)
    .from(portfolioValues)
    .where(
      and(
        eq(portfolioValues.userId, userId),
        eq(portfolioValues.portfolioId, portfolioId),
      ),
    )
    .orderBy(desc(portfolioValues.date))
    .all();
}

export function deleteValue(userId: string, id: string): void {
  const deleted = getDB()
    .delete(portfolioValues)
    .where(and(eq(portfolioValues.userId, userId), eq(portfolioValues.id, id)))
    .returning({ id: portfolioValues.id })
    .all();
  if (deleted.length === 0) throw notFound("Value");
}
