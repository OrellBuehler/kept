import { and, eq, ne } from "drizzle-orm";
import { recordUpdate } from "$lib/server/audit/record";
import { transactionSummary } from "$lib/server/audit/snapshots";
import { first, getDB, transaction, transactions } from "$lib/server/db";
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
  const keys = Object.keys(values) as Array<keyof typeof values & string>;
  const done = await transaction(async (tx) => {
    const where = and(
      eq(transactions.userId, userId),
      eq(transactions.id, transactionId),
      ne(transactions.source, "mirror"),
    );
    const before = await first(
      tx
        .select({
          taxYear: transactions.taxYear,
          deductionYear: transactions.deductionYear,
          deductionExcluded: transactions.deductionExcluded,
          counterpartyName: transactions.counterpartyName,
          description: transactions.description,
        })
        .from(transactions)
        .where(where)
        .limit(1),
    );
    const updated = await tx
      .update(transactions)
      .set(values)
      .where(where)
      .returning({ id: transactions.id });
    if (updated.length === 0 || !before) return false;
    await recordUpdate(
      {
        userId,
        action: "transaction.update",
        entityId: transactionId,
        summary: transactionSummary(before),
      },
      Object.fromEntries(
        keys.map((k) => [k, before[k as keyof typeof before]]),
      ),
      Object.fromEntries(keys.map((k) => [k, values[k] ?? null])),
    );
    return true;
  });
  if (done) return;
  await assertNotMirror(userId, transactionId, action);
  throw notFound("Transaction");
}
