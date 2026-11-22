import { and, eq, isNull } from "drizzle-orm";
import {
  changeLog,
  isUniqueViolation,
  transaction,
  type DB,
} from "$lib/server/db";
import { describeError } from "$lib/server/errors";
import { LedgerError } from "$lib/server/ledger/errors";
import { HANDLERS, type Inverse } from "./handlers";
import { getChange, getChangeInTx } from "./list";
import { insertEntry } from "./record";
import {
  RevertError,
  type ChangeEntry,
  type RevertBatchResult,
  type RevertResult,
} from "./types";

/**
 * Why an entry can never be undone, judged from the entry alone; null when it
 * can be tried. The state of the data decides the rest at revert time
 * (`RevertError` with reason `conflict`).
 */
export function whyNotRevertible(entry: ChangeEntry): string | null {
  if (entry.revertOfEntryId !== null) {
    return "This entry is itself a revert. Make the change again by hand if you want it back.";
  }
  if (entry.revertedAt !== null) return "This change was reverted already.";
  const handler = HANDLERS[entry.entityType];
  if (!handler) return "Changes to this kind of data cannot be reverted.";
  return handler.blocker(entry);
}

/** Whether the UI should offer "revert" for this entry. The current data can still refuse it. */
export function isRevertible(entry: ChangeEntry): boolean {
  return whyNotRevertible(entry) === null;
}

function refusal(entry: ChangeEntry, message: string): RevertError {
  return new RevertError(
    entry.revertedAt !== null ? "already_reverted" : "not_revertible",
    message,
  );
}

async function loadEntry(userId: string, entryId: string) {
  try {
    return await getChange(userId, entryId);
  } catch (err) {
    if (err instanceof LedgerError && err.code === "not_found") {
      throw new RevertError("not_found", "That change was not found.");
    }
    throw err;
  }
}

/**
 * Undoes one entry of the user's change log: a create is deleted, a delete is
 * recreated from `before` (same id), an update gets the `before` values of the
 * fields it changed. It writes an entry of its own (with `revertOfEntryId`)
 * and marks this one reverted, all in one transaction under the lock of the
 * data it touches.
 *
 * Refuses with a `RevertError` (a LedgerError, `message` fit for display) when
 * the entry is already reverted or not revertible, or when the data was changed
 * after the entry so that undoing it would lose that change.
 */
export async function revertChange(
  userId: string,
  entryId: string,
): Promise<RevertResult> {
  const initial = await loadEntry(userId, entryId);
  const blocked = whyNotRevertible(initial);
  if (blocked !== null) throw refusal(initial, blocked);
  const handler = HANDLERS[initial.entityType]!;

  let postCommit: Inverse["postCommit"];
  let newId: string;
  const warnings: string[] = [];
  try {
    newId = await transaction(
      async (tx: DB) => {
        // Read again under the lock: another revert may have won meanwhile.
        const entry = await getChangeInTx(tx, userId, entryId);
        const stillBlocked = whyNotRevertible(entry);
        if (stillBlocked !== null) throw refusal(entry, stillBlocked);
        const inverse = await handler.revert({ tx, userId, entry, warnings });
        postCommit = inverse.postCommit;
        const written = await insertEntry({
          userId,
          action: inverse.action,
          entityId: inverse.entityId,
          summary: inverse.summary,
          before: inverse.before,
          after: inverse.after,
          revertOfEntryId: entry.id,
        });
        const marked = await tx
          .update(changeLog)
          .set({ revertedAt: new Date(), revertedByEntryId: written })
          .where(
            and(
              eq(changeLog.userId, userId),
              eq(changeLog.id, entry.id),
              isNull(changeLog.revertedAt),
            ),
          )
          .returning({ id: changeLog.id });
        if (marked.length === 0) {
          throw new RevertError(
            "already_reverted",
            "This change was reverted already.",
          );
        }
        return written;
      },
      { lock: handler.lock(userId, initial) },
    );
  } catch (err) {
    if (err instanceof RevertError) throw err;
    if (err instanceof LedgerError) {
      // A validation of the shared code refused the inverse change.
      throw new RevertError("conflict", err.message);
    }
    if (isUniqueViolation(err)) {
      throw new RevertError(
        "conflict",
        "The data changed while reverting, try again.",
      );
    }
    throw err;
  }
  if (postCommit) {
    try {
      await postCommit();
    } catch (err) {
      // The revert is committed; leftovers are swept later.
      console.error("revert follow-up failed: %s", describeError(err));
    }
  }
  return {
    entry: await getChange(userId, newId),
    reverted: await getChange(userId, entryId),
    warnings,
  };
}

/**
 * Reverts several entries, newest first (so a change made on top of another is
 * undone before it), each in its own transaction. Stops at the first entry
 * that is refused and reports it; what was reverted before it stays reverted.
 * Entries that were reverted already are skipped. Unknown ids are reported
 * before anything is changed.
 */
export async function revertChanges(
  userId: string,
  entryIds: readonly string[],
): Promise<RevertBatchResult> {
  const entries: ChangeEntry[] = [];
  for (const id of new Set(entryIds)) {
    try {
      entries.push(await loadEntry(userId, id));
    } catch (err) {
      if (err instanceof RevertError) {
        return { results: [], stoppedAt: { entryId: id, error: err } };
      }
      throw err;
    }
  }
  entries.sort((a, b) => b.seq - a.seq || (a.id < b.id ? 1 : -1));
  const results: RevertResult[] = [];
  for (const entry of entries) {
    if (entry.revertedAt !== null && entry.revertOfEntryId === null) continue;
    try {
      results.push(await revertChange(userId, entry.id));
    } catch (err) {
      if (err instanceof RevertError) {
        return { results, stoppedAt: { entryId: entry.id, error: err } };
      }
      throw err;
    }
  }
  return { results, stoppedAt: null };
}
