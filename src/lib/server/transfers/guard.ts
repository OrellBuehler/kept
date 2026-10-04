import { and, eq } from "drizzle-orm";
import { first, getDB, transactions } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";

/** Mirrors only carry a note and a category; anything else is the source row's business. */
export async function assertNotMirror(
  userId: string,
  transactionId: string,
  action: string,
): Promise<void> {
  const row = await first(
    getDB()
      .select({ source: transactions.source })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, transactionId),
        ),
      )
      .limit(1),
  );
  if (!row) throw notFound("Transaction");
  if (row.source === "mirror") {
    throw new LedgerError(
      "conflict",
      `A mirrored transfer cannot be ${action}.`,
    );
  }
}
