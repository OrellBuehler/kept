import { and, eq, gte, lte, or } from "drizzle-orm";
import { getDB, transactions, transfers } from "$lib/server/db";
import {
  LINK_WINDOW_DAYS,
  matchMirrors,
  shiftDate,
  type IncomingRow,
} from "./plan";
import type { Conn } from "./link";

/**
 * Which rows of an incoming statement for `accountId` take over a mirror:
 * row key -> mirror id (see `matchMirrors`). Rows are matched by amount, date
 * and counterparty only; they are not in the database yet.
 */
export function findReplacements(
  userId: string,
  accountId: string,
  rows: readonly IncomingRow[],
  conn: Conn = getDB(),
): Map<string, string> {
  if (rows.length === 0) return new Map();
  let first = rows[0]!.bookingDate;
  let last = first;
  for (const r of rows) {
    if (r.bookingDate < first) first = r.bookingDate;
    if (r.bookingDate > last) last = r.bookingDate;
  }
  const mirrors = conn
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      counterpartyIban: transactions.counterpartyIban,
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
    )
    .all();
  return matchMirrors(rows, mirrors);
}

/**
 * A real row replaces a mirror: the transfer keeps pointing at the same
 * account pair, now at the real row (method `paired`); the mirror's note and
 * category move to the real row; the mirror is deleted.
 */
export function takeOverMirror(
  userId: string,
  mirrorId: string,
  realId: string,
  conn: Conn,
): void {
  const mirror = conn
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
  const row = conn
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
    conn
      .update(transfers)
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
    const keep = conn
      .select({ note: transactions.note, categoryId: transactions.categoryId })
      .from(transactions)
      .where(eq(transactions.id, realId))
      .get();
    conn
      .update(transactions)
      .set({
        note: keep?.note ?? mirror.note,
        categoryId: mirror.categoryId ?? keep?.categoryId ?? null,
      })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, realId)))
      .run();
  }
  conn
    .delete(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, mirrorId)))
    .run();
}
