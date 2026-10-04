import { and, desc, eq, inArray } from "drizzle-orm";
import type { TradeSide } from "$lib/investment-types";
import type { Minor } from "$lib/money";
import type { Fixed8 } from "$lib/quantity";
import {
  accounts,
  getDB,
  securities,
  securityPrices,
  trades,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { TradeInput } from "./schemas";
import {
  firstEmptySplit,
  firstOversell,
  type SequenceTrade,
} from "./valuation";

export interface TradeView {
  id: string;
  accountId: string;
  securityId: string;
  securityName: string;
  securityCurrency: string;
  date: string;
  side: TradeSide;
  /** For a split, the ratio of new to old shares (an approximation when `splitNew` is set). */
  quantity: Fixed8;
  /** Split only: the exact integer ratio `splitNew : splitOld`, when it was entered that way. */
  splitNew: number | null;
  splitOld: number | null;
  /** Per unit, in the security's currency. */
  price: Fixed8;
  /** Account currency. */
  fees: Minor;
  /** Account currency, positive: cash paid or received including fees. */
  amount: Minor;
  note: string | null;
}

const columns = {
  id: trades.id,
  accountId: trades.accountId,
  securityId: trades.securityId,
  securityName: securities.name,
  securityCurrency: securities.currency,
  date: trades.date,
  side: trades.side,
  quantity: trades.quantity,
  splitNew: trades.splitNew,
  splitOld: trades.splitOld,
  price: trades.price,
  fees: trades.fees,
  amount: trades.amount,
  note: trades.note,
};

function assertAccount(userId: string, accountId: string) {
  const found = getDB()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!found) throw notFound("Account");
}

function assertSecurity(userId: string, securityId: string) {
  const found = getDB()
    .select({ id: securities.id })
    .from(securities)
    .where(and(eq(securities.userId, userId), eq(securities.id, securityId)))
    .get();
  if (!found) throw notFound("Security");
}

/** Newest first. */
export function listTrades(userId: string, accountId: string): TradeView[] {
  assertAccount(userId, accountId);
  return getDB()
    .select(columns)
    .from(trades)
    .innerJoin(securities, eq(securities.id, trades.securityId))
    .where(and(eq(trades.userId, userId), eq(trades.accountId, accountId)))
    .orderBy(desc(trades.date), desc(trades.createdAt), desc(trades.id))
    .all();
}

export function getTrade(userId: string, id: string): TradeView {
  const row = getDB()
    .select(columns)
    .from(trades)
    .innerJoin(securities, eq(securities.id, trades.securityId))
    .where(and(eq(trades.userId, userId), eq(trades.id, id)))
    .get();
  if (!row) throw notFound("Trade");
  return row;
}

interface SequenceChange {
  accountId: string;
  securityId: string;
  /** Existing trade that is replaced or removed. */
  excludeId?: string;
  /** Trade that is added or replaces `excludeId`. */
  add?: SequenceTrade;
}

/** Rejects a change after which the held quantity is negative on any date. */
function assertSequence(userId: string, change: SequenceChange) {
  const rows = getDB()
    .select({
      id: trades.id,
      date: trades.date,
      side: trades.side,
      quantity: trades.quantity,
      splitNew: trades.splitNew,
      splitOld: trades.splitOld,
    })
    .from(trades)
    .where(
      and(
        eq(trades.userId, userId),
        eq(trades.accountId, change.accountId),
        eq(trades.securityId, change.securityId),
      ),
    )
    .all()
    .filter((t) => t.id !== change.excludeId);
  const sequence: SequenceTrade[] = rows;
  if (change.add) sequence.push(change.add);
  const field = change.add ? "quantity" : undefined;
  let date: string | null;
  let emptySplit: string | null;
  try {
    date = firstOversell(sequence);
    emptySplit = firstEmptySplit(sequence);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new LedgerError(
      "invalid",
      "The resulting quantity is too large.",
      field,
    );
  }
  if (date !== null) {
    throw new LedgerError(
      "conflict",
      `This would leave a negative holding on ${date}.`,
      field,
    );
  }
  if (emptySplit !== null) {
    throw new LedgerError(
      "conflict",
      `There are no shares to split on ${emptySplit}.`,
      field,
    );
  }
}

/**
 * Provider prices are split-adjusted when they are fetched (see valuation.ts), so any change to
 * a security's splits leaves the stored ones in the wrong units. Dropping them makes the next
 * market data refresh backfill the whole range from the first trade.
 */
function discardProviderPrices(userId: string, securityIds: string[]) {
  getDB()
    .delete(securityPrices)
    .where(
      and(
        eq(securityPrices.userId, userId),
        eq(securityPrices.source, "provider"),
        inArray(securityPrices.securityId, securityIds),
      ),
    )
    .run();
}

export function createTrade(
  userId: string,
  accountId: string,
  input: TradeInput,
): TradeView {
  assertAccount(userId, accountId);
  assertSecurity(userId, input.securityId);
  assertSequence(userId, {
    accountId,
    securityId: input.securityId,
    add: input,
  });
  const row = getDB().transaction(() => {
    const inserted = getDB()
      .insert(trades)
      .values({ ...input, userId, accountId })
      .returning({ id: trades.id })
      .get();
    if (input.side === "split") {
      discardProviderPrices(userId, [input.securityId]);
    }
    return inserted;
  });
  return getTrade(userId, row.id);
}

export function updateTrade(
  userId: string,
  id: string,
  input: TradeInput,
): TradeView {
  const current = getTrade(userId, id);
  assertSecurity(userId, input.securityId);
  if (input.securityId === current.securityId) {
    assertSequence(userId, {
      accountId: current.accountId,
      securityId: current.securityId,
      excludeId: id,
      add: input,
    });
  } else {
    assertSequence(userId, {
      accountId: current.accountId,
      securityId: current.securityId,
      excludeId: id,
    });
    assertSequence(userId, {
      accountId: current.accountId,
      securityId: input.securityId,
      add: input,
    });
  }
  getDB().transaction(() => {
    getDB()
      .update(trades)
      .set({ splitNew: null, splitOld: null, ...input })
      .where(and(eq(trades.userId, userId), eq(trades.id, id)))
      .run();
    if (current.side === "split") {
      discardProviderPrices(userId, [current.securityId]);
    }
    if (input.side === "split") {
      discardProviderPrices(userId, [input.securityId]);
    }
  });
  return getTrade(userId, id);
}

export function deleteTrade(userId: string, id: string): void {
  const current = getTrade(userId, id);
  assertSequence(userId, {
    accountId: current.accountId,
    securityId: current.securityId,
    excludeId: id,
  });
  getDB().transaction(() => {
    getDB()
      .delete(trades)
      .where(and(eq(trades.userId, userId), eq(trades.id, id)))
      .run();
    if (current.side === "split") {
      discardProviderPrices(userId, [current.securityId]);
    }
  });
}
