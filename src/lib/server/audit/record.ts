import { isDeepStrictEqual } from "node:util";
import { changeLog, first, getDB, inTransaction } from "$lib/server/db";
import { currentActor, type Actor } from "./context";
import { entityTypeOf, type RecordChangeInput, type Snapshot } from "./types";

/** What the entry says about who acted. A system entry has no token. */
export function actorFor(userId: string): {
  kind: Actor["kind"];
  tokenId: string | null;
  label: string | null;
} {
  const actor = currentActor();
  if (!actor) return { kind: "system", tokenId: null, label: null };
  if (actor.kind !== "system" && actor.userId !== userId) {
    // Acting for one user on another's data never happens; do not credit it to
    // the first as their own change.
    console.warn("change recorded by an actor that does not own the data");
    return { kind: "system", tokenId: null, label: null };
  }
  return {
    kind: actor.kind,
    tokenId: actor.tokenId ?? null,
    label: actor.label ?? null,
  };
}

interface EntryInsert extends RecordChangeInput {
  revertOfEntryId?: string;
}

/** Inserts the row; the one place that writes `change_log`. Returns its id. */
export async function insertEntry(input: EntryInsert): Promise<string> {
  if (!inTransaction()) {
    throw new Error(
      "recordChange must run inside transaction(): the entry has to commit or roll back with the change",
    );
  }
  const actor = actorFor(input.userId);
  const row = await first(
    getDB()
      .insert(changeLog)
      .values({
        userId: input.userId,
        actorKind: actor.kind,
        actorTokenId: actor.tokenId,
        actorLabel: actor.label,
        action: input.action,
        entityType: entityTypeOf(input.action),
        entityId: input.entityId,
        summary: input.summary ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        revertOfEntryId: input.revertOfEntryId ?? null,
      })
      .returning({ id: changeLog.id }),
  );
  return row!.id;
}

/**
 * Writes one change-log entry in the caller's open transaction, so it commits
 * or rolls back with the change it describes. The actor comes from the request
 * (`runAsActor`), or is the system when there is none. Throws outside a
 * transaction.
 *
 * `before` / `after` carry values only (see `Snapshot`); never put secrets in
 * them. An update passes only the fields it touched, which `diff()` computes.
 */
export async function recordChange(input: RecordChangeInput): Promise<string> {
  return await insertEntry(input);
}

/**
 * The fields of `after` that differ from `before`, as `{ before, after }`
 * holding only those fields; null when nothing changed (nothing to record).
 * Both must carry the same keys.
 */
export function diff(
  before: Snapshot,
  after: Snapshot,
): { before: Snapshot; after: Snapshot } | null {
  const b: Snapshot = {};
  const a: Snapshot = {};
  for (const key of Object.keys(after)) {
    if (!isDeepStrictEqual(before[key], after[key])) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return Object.keys(a).length === 0 ? null : { before: b, after: a };
}

/**
 * Records an update of `before` into `after` (full snapshots of the entity)
 * as the fields that changed. Does nothing when none did.
 */
export async function recordUpdate(
  input: Omit<RecordChangeInput, "before" | "after">,
  before: Snapshot,
  after: Snapshot,
): Promise<void> {
  const changed = diff(before, after);
  if (changed) await recordChange({ ...input, ...changed });
}
