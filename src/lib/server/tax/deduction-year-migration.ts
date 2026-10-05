import { and, count, eq } from "drizzle-orm";
import {
  deductionYearMigration,
  first,
  getDB,
  transactions,
  transaction,
} from "$lib/server/db";

/** Rows the deduction-year update moved out of the tax payments of `year`, still awaiting review. */
export async function countDeductionYearMoves(
  userId: string,
  year: number,
): Promise<number> {
  return (await first(
    getDB()
      .select({ n: count() })
      .from(deductionYearMigration)
      .where(
        and(
          eq(deductionYearMigration.userId, userId),
          eq(deductionYearMigration.oldTaxYear, year),
        ),
      )
      .limit(1),
  ))!.n;
}

/**
 * Moves the recorded transactions of `year` back to tax payments and forgets the records.
 * A transaction whose deduction year was changed since is left as the user set it.
 * Returns how many transactions were restored.
 */
export async function undoDeductionYearMoves(
  userId: string,
  year: number,
): Promise<number> {
  return await transaction(async (tx) => {
    const records = await tx
      .select()
      .from(deductionYearMigration)
      .where(
        and(
          eq(deductionYearMigration.userId, userId),
          eq(deductionYearMigration.oldTaxYear, year),
        ),
      );
    let restored = 0;
    for (const record of records) {
      const updated = await tx
        .update(transactions)
        .set({ taxYear: record.oldTaxYear, deductionYear: null })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, record.transactionId),
            eq(transactions.deductionYear, record.oldTaxYear),
          ),
        )
        .returning({ id: transactions.id });
      restored += updated.length;
    }
    await tx
      .delete(deductionYearMigration)
      .where(
        and(
          eq(deductionYearMigration.userId, userId),
          eq(deductionYearMigration.oldTaxYear, year),
        ),
      );
    return restored;
  });
}

/** Keeps the move and forgets the records. Returns how many records were removed. */
export async function dismissDeductionYearMoves(
  userId: string,
  year: number,
): Promise<number> {
  return (
    await getDB()
      .delete(deductionYearMigration)
      .where(
        and(
          eq(deductionYearMigration.userId, userId),
          eq(deductionYearMigration.oldTaxYear, year),
        ),
      )
      .returning({ id: deductionYearMigration.id })
  ).length;
}
