import { and, eq } from "drizzle-orm";
import { getDB, transactions } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";

/** Mirrors only carry a note and a category; anything else is the source row's business. */
export function assertNotMirror(
  userId: string,
  transactionId: string,
  action: string,
): void {
  const row = getDB()
    .select({ source: transactions.source })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, transactionId)),
    )
    .get();
  if (!row) throw notFound("Transaction");
  if (row.source === "mirror") {
    throw new LedgerError(
      "conflict",
      `A mirrored transfer cannot be ${action}.`,
    );
  }
}
