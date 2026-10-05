import { and, eq, gte, lte, or } from "drizzle-orm";
import { getDB, transactions, transfers, type DB } from "$lib/server/db";
import {
  LINK_WINDOW_DAYS,
  matchMirrors,
  shiftDate,
  type IncomingRow,
} from "./plan";
import type { Tx } from "./link";

function mirrorQuery(
  conn: Pick<DB, "select">,
  userId: string,
  accountId: string,
  first: string,
  last: string,
) {
  return conn
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      counterpartyIban: transactions.counterpartyIban,
      reference: transactions.reference,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.source, "mirror"),
        gte(transactions.bookingDate, shiftDate(first, -LINK_WINDOW_DAYS)),
        lte(transactions.bookingDate, shiftDate(last, LINK_WINDOW_DAYS)),
      ),
    );
}

function dateRange(rows: readonly IncomingRow[]): [string, string] {
  let first = rows[0]!.bookingDate;
  let last = first;
  for (const r of rows) {
    if (r.bookingDate < first) first = r.bookingDate;
    if (r.bookingDate > last) last = r.bookingDate;
  }
  return [first, last];
}

/**
 * Which rows of an incoming statement for `accountId` take over a mirror:
 * row key -> mirror id (see `matchMirrors`). Rows are matched by amount, date
 * counterparty and, for rows without a counterparty IBAN, reference or text;
 * they are not in the database yet.
 */
export async function findReplacements(
  userId: string,
  accountId: string,
  rows: readonly IncomingRow[],
): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  const [first, last] = dateRange(rows);
  const mirrors = await mirrorQuery(getDB(), userId, accountId, first, last);
  return matchMirrors(rows, mirrors);
}

/** Sync twin of findReplacements, for the body of a transaction. */
export function findReplacementsInTx(
  tx: Pick<DB, "select">,
  userId: string,
  accountId: string,
  rows: readonly IncomingRow[],
): Map<string, string> {
  if (rows.length === 0) return new Map();
  const [first, last] = dateRange(rows);
  return matchMirrors(
    rows,
    mirrorQuery(tx, userId, accountId, first, last).all(),
  );
}

/**
 * A real row replaces a mirror: the transfer keeps pointing at the same
 * account pair, now at the real row (method `paired`); the mirror's note and
 * category move to the real row; the mirror is deleted.
 */
export function takeOverMirror(
  tx: Tx,
  userId: string,
  mirrorId: string,
  realId: string,
): void {
  const mirror = tx
    .select({
      note: transactions.note,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, mirrorId),
        eq(transactions.source, "mirror"),
      ),
    )
    .get();
  if (!mirror) return;
  const row = tx
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        or(
          eq(transfers.outTransactionId, mirrorId),
          eq(transfers.inTransactionId, mirrorId),
        ),
      ),
    )
    .get();
  if (row) {
    tx.update(transfers)
      .set({
        method: "paired",
        outTransactionId:
          row.outTransactionId === mirrorId ? realId : row.outTransactionId,
        inTransactionId:
          row.inTransactionId === mirrorId ? realId : row.inTransactionId,
      })
      .where(eq(transfers.id, row.id))
      .run();
  }
  if (mirror.note !== null || mirror.categoryId !== null) {
    const keep = tx
      .select({ note: transactions.note, categoryId: transactions.categoryId })
      .from(transactions)
      .where(eq(transactions.id, realId))
      .get();
    tx.update(transactions)
      .set({
        note: keep?.note ?? mirror.note,
        categoryId: mirror.categoryId ?? keep?.categoryId ?? null,
      })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, realId)))
      .run();
  }
  tx.delete(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, mirrorId)))
    .run();
}
