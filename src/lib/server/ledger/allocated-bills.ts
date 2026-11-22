import { and, asc, eq, type SQL } from "drizzle-orm";
import {
  afterCommit,
  billAllocations,
  transactions,
  type DB,
} from "$lib/server/db";
import { emitBillChanged } from "$lib/server/events";

/**
 * Bills that have a payment allocated among the transactions selected by `where`.
 * Read before those rows are deleted: the allocations cascade with them.
 */
export async function billsAllocatedIn(
  tx: Pick<DB, "select">,
  userId: string,
  where: SQL | undefined,
): Promise<string[]> {
  const rows = await tx
    .select({ billId: billAllocations.billId })
    .from(billAllocations)
    .innerJoin(transactions, eq(transactions.id, billAllocations.transactionId))
    .where(and(eq(billAllocations.userId, userId), where))
    .groupBy(billAllocations.billId)
    .orderBy(asc(billAllocations.billId));
  return rows.map((r) => r.billId);
}

/** Announces the bills after the commit: their status is derived from allocations that just went away. */
export function announceBills(
  userId: string,
  billIds: readonly string[],
): void {
  for (const billId of billIds) {
    afterCommit(() => emitBillChanged(userId, billId));
  }
}
