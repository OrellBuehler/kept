import { and, desc, eq } from "drizzle-orm";
import type { RowSource } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import { accounts, balanceSnapshots, getDB } from "$lib/server/db";
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

function assertAccount(userId: string, accountId: string) {
  const found = getDB()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!found) throw notFound("Account");
}

/** Newest first. */
export function listSnapshots(
  userId: string,
  accountId: string,
): SnapshotView[] {
  assertAccount(userId, accountId);
  return getDB()
    .select(columns)
    .from(balanceSnapshots)
    .where(
      and(
        eq(balanceSnapshots.userId, userId),
        eq(balanceSnapshots.accountId, accountId),
      ),
    )
    .orderBy(desc(balanceSnapshots.date), desc(balanceSnapshots.source))
    .all();
}

export function getSnapshot(userId: string, id: string): SnapshotView {
  const row = getDB()
    .select(columns)
    .from(balanceSnapshots)
    .where(
      and(eq(balanceSnapshots.userId, userId), eq(balanceSnapshots.id, id)),
    )
    .get();
  if (!row) throw notFound("Balance");
  return row;
}

/*
 * Note for the import flow: imported snapshots must be upserted on
 * (accountId, date, source="import"); this helper only creates manual ones and
 * rejects a second manual snapshot for the same date.
 */
export function createSnapshot(
  userId: string,
  accountId: string,
  input: SnapshotInput,
): SnapshotView {
  assertAccount(userId, accountId);
  const clash = getDB()
    .select({ id: balanceSnapshots.id })
    .from(balanceSnapshots)
    .where(
      and(
        eq(balanceSnapshots.accountId, accountId),
        eq(balanceSnapshots.date, input.date),
        eq(balanceSnapshots.source, "manual"),
      ),
    )
    .get();
  if (clash) {
    throw new LedgerError(
      "conflict",
      "A balance is already recorded for this date.",
      "date",
    );
  }
  const row = getDB()
    .insert(balanceSnapshots)
    .values({ ...input, userId, accountId, source: "manual" })
    .returning({ id: balanceSnapshots.id })
    .get();
  return getSnapshot(userId, row.id);
}

/** Manual balances only; imported ones go away with their import. */
export function deleteSnapshot(userId: string, id: string): void {
  const current = getSnapshot(userId, id);
  if (current.source !== "manual") {
    throw new LedgerError(
      "conflict",
      "Imported balances cannot be deleted. Delete the import instead.",
    );
  }
  getDB()
    .delete(balanceSnapshots)
    .where(
      and(eq(balanceSnapshots.userId, userId), eq(balanceSnapshots.id, id)),
    )
    .run();
}
