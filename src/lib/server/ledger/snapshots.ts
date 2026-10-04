import { and, desc, eq } from "drizzle-orm";
import type { RowSource } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  first,
  getDB,
  isUniqueViolation,
} from "$lib/server/db";
import { LedgerError, notFound } from "./errors";
import type { SnapshotInput } from "./schemas";

export interface SnapshotView {
  id: string;
  accountId: string;
  importId: string | null;
  source: RowSource;
  /** End-of-day balance on this date. */
  date: string;
  amount: Minor;
  note: string | null;
}

const columns = {
  id: balanceSnapshots.id,
  accountId: balanceSnapshots.accountId,
  importId: balanceSnapshots.importId,
  source: balanceSnapshots.source,
  date: balanceSnapshots.date,
  amount: balanceSnapshots.amount,
  note: balanceSnapshots.note,
};

async function assertAccount(userId: string, accountId: string) {
  const found = await first(
    getDB()
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!found) throw notFound("Account");
}

/** Newest first. */
export async function listSnapshots(
  userId: string,
  accountId: string,
): Promise<SnapshotView[]> {
  await assertAccount(userId, accountId);
  return await getDB()
    .select(columns)
    .from(balanceSnapshots)
    .where(
      and(
        eq(balanceSnapshots.userId, userId),
        eq(balanceSnapshots.accountId, accountId),
      ),
    )
    .orderBy(desc(balanceSnapshots.date), desc(balanceSnapshots.source));
}

export async function getSnapshot(
  userId: string,
  id: string,
): Promise<SnapshotView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(balanceSnapshots)
      .where(
        and(eq(balanceSnapshots.userId, userId), eq(balanceSnapshots.id, id)),
      )
      .limit(1),
  );
  if (!row) throw notFound("Balance");
  return row;
}

/*
 * Note for the import flow: imported snapshots must be upserted on
 * (accountId, date, source="import"); this helper only creates manual ones and
 * rejects a second manual snapshot for the same date.
 */
export async function createSnapshot(
  userId: string,
  accountId: string,
  input: SnapshotInput,
): Promise<SnapshotView> {
  await assertAccount(userId, accountId);
  let row: { id: string };
  try {
    // The unique index on (account, date, source) rejects a second manual balance for the date.
    row = (
      await getDB()
        .insert(balanceSnapshots)
        .values({ ...input, userId, accountId, source: "manual" })
        .returning({ id: balanceSnapshots.id })
    )[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new LedgerError(
        "conflict",
        "A balance is already recorded for this date.",
        "date",
      );
    }
    throw err;
  }
  return await getSnapshot(userId, row.id);
}

/** Manual balances only; imported ones go away with their import. */
export async function deleteSnapshot(
  userId: string,
  id: string,
): Promise<void> {
  const current = await getSnapshot(userId, id);
  if (current.source !== "manual") {
    throw new LedgerError(
      "conflict",
      "Imported balances cannot be deleted. Delete the import instead.",
    );
  }
  await getDB()
    .delete(balanceSnapshots)
    .where(
      and(eq(balanceSnapshots.userId, userId), eq(balanceSnapshots.id, id)),
    );
}
