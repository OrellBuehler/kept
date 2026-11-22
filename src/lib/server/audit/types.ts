import { LedgerError, type LedgerErrorCode } from "$lib/server/ledger/errors";
import type { ActorKind } from "$lib/server/db/schema";

/** What an action does to its entity; revert undoes it by the inverse of this. */
export type ChangeOp = "create" | "update" | "delete" | "other";

/**
 * Every action the change log records. The entity type is the part before the
 * dot. `other` actions are recorded for the history only and never revertible.
 */
export const CHANGE_ACTIONS = {
  "bill.create": "create",
  "bill.update": "update",
  "bill.cancel": "update",
  "bill.uncancel": "update",
  "bill.delete": "delete",
  "allocation.create": "create",
  "allocation.auto_match": "create",
  "allocation.delete": "delete",
  "match_dismissal.create": "create",
  "match_dismissal.delete": "delete",
  "transaction.create": "create",
  "transaction.update": "update",
  "transaction.delete": "delete",
  "category.create": "create",
  "category.update": "update",
  "category.delete": "delete",
  "category_rule.create": "create",
  "category_rule.update": "update",
  "category_rule.delete": "delete",
  "category_rule.apply": "other",
  "account.create": "create",
  "account.update": "update",
  "account.archive": "update",
  "account.unarchive": "update",
  "account.delete": "delete",
  "institution.create": "create",
  "institution.update": "update",
  "institution.delete": "delete",
  "snapshot.create": "create",
  "snapshot.delete": "delete",
  "budget.create": "create",
  "budget.update": "update",
  "budget.delete": "delete",
  "planned_item.create": "create",
  "planned_item.update": "update",
  "planned_item.delete": "delete",
  "forecast_setting.update": "update",
  "recurring_series.update": "update",
  "tax_year.create": "create",
  "tax_year.update": "update",
  "tax_year.delete": "delete",
  "tax_credit.create": "create",
  "tax_credit.delete": "delete",
  "deduction_mapping.update": "update",
  "preference.update": "update",
  "import.confirm": "other",
  "import.undo": "other",
  "external_link.create": "create",
  "external_link.update": "update",
  "external_link.delete": "delete",
} as const satisfies Record<string, ChangeOp>;

export type ChangeAction = keyof typeof CHANGE_ACTIONS;

export function opOf(action: string): ChangeOp {
  return (CHANGE_ACTIONS as Record<string, ChangeOp>)[action] ?? "other";
}

export function entityTypeOf(action: ChangeAction): string {
  return action.slice(0, action.indexOf("."));
}

/** A JSON object of values: minor units, `YYYY-MM-DD` strings, epoch milliseconds, booleans, ids. */
export type Snapshot = Record<string, unknown>;

/**
 * What `listChanges` shows in place of a list inside `before` / `after` that
 * has more than `LIST_ARRAY_LIMIT` items (the ids of the payments a rule run
 * filed, say). `getChange` returns the whole list.
 */
export interface TruncatedList {
  count: number;
  truncated: true;
}

/** Lists longer than this are shown as a `TruncatedList` by `listChanges`. */
export const LIST_ARRAY_LIMIT = 20;

/**
 * The most payment ids one entry stores so that it can be reverted. A rule run
 * or a category delete that touches more records only their number; such an
 * entry is not revertible.
 */
export const MAX_REVERTIBLE_IDS = 10_000;

export function isTruncatedList(value: unknown): value is TruncatedList {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as TruncatedList).truncated === true &&
    typeof (value as TruncatedList).count === "number"
  );
}

export interface ChangeActor {
  kind: ActorKind;
  tokenId: string | null;
  label: string | null;
}

/** One row of the change log as the UI and the mcp connection see it. */
export interface ChangeEntry {
  id: string;
  /** Insertion order; the listing key. */
  seq: number;
  /** When the change was committed, epoch milliseconds. */
  at: number;
  actor: ChangeActor;
  action: string;
  entityType: string;
  entityId: string;
  summary: string | null;
  /**
   * Creates: null. Updates: only the fields the change touched, as they were.
   * Deletes: the whole entity (and what went with it) as it was.
   */
  before: Snapshot | null;
  /** Creates: the whole entity. Updates: the touched fields as they became. Deletes: null. */
  after: Snapshot | null;
  revertedAt: number | null;
  revertedByEntryId: string | null;
  /** Set on the entry a revert writes: the entry it undid. */
  revertOfEntryId: string | null;
}

export interface RecordChangeInput {
  /** The owner of the data. */
  userId: string;
  action: ChangeAction;
  entityId: string;
  /** A short label such as a creditor name. Never an amount. */
  summary?: string | null;
  before?: Snapshot | null;
  after?: Snapshot | null;
}

export type RevertFailure =
  "not_found" | "already_reverted" | "not_revertible" | "conflict";

const CODE: Record<RevertFailure, LedgerErrorCode> = {
  not_found: "not_found",
  already_reverted: "conflict",
  not_revertible: "invalid",
  conflict: "conflict",
};

/**
 * A revert that was refused. `message` is written for the person looking at
 * the log. It is a LedgerError, so the existing form and API error mapping
 * handles it (`code` is not_found, conflict or invalid); `reason` tells the
 * cases apart.
 */
export class RevertError extends LedgerError {
  override name = "RevertError";
  constructor(
    readonly reason: RevertFailure,
    message: string,
  ) {
    super(CODE[reason], message);
  }
}

export interface RevertResult {
  /** The entry the revert wrote. */
  entry: ChangeEntry;
  /** The entry that was undone, now marked reverted. */
  reverted: ChangeEntry;
  /** What could not be restored along with it (a deleted document, say). */
  warnings: string[];
}

export interface RevertBatchResult {
  results: RevertResult[];
  /** The first entry that was refused; the ones after it were not tried. */
  stoppedAt: { entryId: string; error: RevertError } | null;
}
