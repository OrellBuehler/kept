import { and, eq, ne } from "drizzle-orm";
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

/**
 * Updates a transaction that is not a mirror, in one statement: the mirror
 * guard is part of the WHERE clause, so the row cannot change into a mirror
 * between a check and the write. A miss is explained by `assertNotMirror`.
 */
export async function updateUnlessMirror(
  userId: string,
  transactionId: string,
  values: Partial<typeof transactions.$inferInsert>,
  action: string,
): Promise<void> {
  const updated = await getDB()
    .update(transactions)
    .set(values)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, transactionId),
        ne(transactions.source, "mirror"),
      ),
    )
    .returning({ id: transactions.id });
  if (updated.length > 0) return;
  await assertNotMirror(userId, transactionId, action);
  throw notFound("Transaction");
}
