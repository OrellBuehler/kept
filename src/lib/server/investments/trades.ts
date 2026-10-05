import { and, desc, eq, inArray } from "drizzle-orm";
import type { TradeSide } from "$lib/investment-types";
import type { Minor } from "$lib/money";
import type { Fixed8 } from "$lib/quantity";
import {
  type DB,
  accounts,
  first,
  getDB,
  securities,
  securityPrices,
  trades,
  transaction,
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

type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;

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

async function assertAccountInTx(tx: Tx, userId: string, accountId: string) {
  const found = await first(
    tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!found) throw notFound("Account");
}

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

async function getTradeInTx(
  tx: Tx,
  userId: string,
  id: string,
): Promise<TradeView> {
  const row = await first(
    tx
      .select(columns)
      .from(trades)
      .innerJoin(securities, eq(securities.id, trades.securityId))
      .where(and(eq(trades.userId, userId), eq(trades.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Trade");
  return row;
}

/** Newest first. */
export async function listTrades(
  userId: string,
  accountId: string,
): Promise<TradeView[]> {
  const db = getDB();
  const found = await first(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!found) throw notFound("Account");
  return await db
    .select(columns)
    .from(trades)
    .innerJoin(securities, eq(securities.id, trades.securityId))
    .where(and(eq(trades.userId, userId), eq(trades.accountId, accountId)))
    .orderBy(
      desc(trades.date),
      desc(trades.createdAt),
      desc(trades.seq),
      desc(trades.id),
    );
}

export async function getTrade(userId: string, id: string): Promise<TradeView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(trades)
      .innerJoin(securities, eq(securities.id, trades.securityId))
      .where(and(eq(trades.userId, userId), eq(trades.id, id)))
      .limit(1),
  );
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

/**
 * Rejects a change after which the held quantity is negative on any date.
 * Runs in the transaction that writes the change, so a concurrent trade cannot
 * invalidate the check.
 */
async function assertSequenceInTx(
  tx: Tx,
  userId: string,
  change: SequenceChange,
) {
  const rows = (
    await tx
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
  ).filter((t) => t.id !== change.excludeId);
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
async function discardProviderPrices(
  tx: Tx,
  userId: string,
  securityIds: string[],
) {
  await tx
    .delete(securityPrices)
    .where(
      and(
        eq(securityPrices.userId, userId),
        eq(securityPrices.source, "provider"),
        inArray(securityPrices.securityId, securityIds),
      ),
    );
}

export async function createTrade(
  userId: string,
  accountId: string,
  input: TradeInput,
): Promise<TradeView> {
  const row = await transaction(async (tx) => {
    await assertAccountInTx(tx, userId, accountId);
    await assertSecurityInTx(tx, userId, input.securityId);
    await assertSequenceInTx(tx, userId, {
      accountId,
      securityId: input.securityId,
      add: input,
    });
    const inserted = (await first(
      tx
        .insert(trades)
        .values({ ...input, userId, accountId })
        .returning({ id: trades.id }),
    ))!;
    if (input.side === "split") {
      await discardProviderPrices(tx, userId, [input.securityId]);
    }
    return inserted;
  });
  return await getTrade(userId, row.id);
}

export async function updateTrade(
  userId: string,
  id: string,
  input: TradeInput,
): Promise<TradeView> {
  await transaction(async (tx) => {
    const current = await getTradeInTx(tx, userId, id);
    await assertSecurityInTx(tx, userId, input.securityId);
    if (input.securityId === current.securityId) {
      await assertSequenceInTx(tx, userId, {
        accountId: current.accountId,
        securityId: current.securityId,
        excludeId: id,
        add: input,
      });
    } else {
      await assertSequenceInTx(tx, userId, {
        accountId: current.accountId,
        securityId: current.securityId,
        excludeId: id,
      });
      await assertSequenceInTx(tx, userId, {
        accountId: current.accountId,
        securityId: input.securityId,
        add: input,
      });
    }
    await tx
      .update(trades)
      .set({ splitNew: null, splitOld: null, ...input })
      .where(and(eq(trades.userId, userId), eq(trades.id, id)));
    if (current.side === "split") {
      await discardProviderPrices(tx, userId, [current.securityId]);
    }
    if (input.side === "split") {
      await discardProviderPrices(tx, userId, [input.securityId]);
    }
  });
  return await getTrade(userId, id);
}

export async function deleteTrade(userId: string, id: string): Promise<void> {
  await transaction(async (tx) => {
    const current = await getTradeInTx(tx, userId, id);
    await assertSequenceInTx(tx, userId, {
      accountId: current.accountId,
      securityId: current.securityId,
      excludeId: id,
    });
    await tx
      .delete(trades)
      .where(and(eq(trades.userId, userId), eq(trades.id, id)));
    if (current.side === "split") {
      await discardProviderPrices(tx, userId, [current.securityId]);
    }
  });
}
