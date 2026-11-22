import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { ACTOR_KINDS, changeLog, first, getDB, type DB } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import {
  LIST_ARRAY_LIMIT,
  type ChangeEntry,
  type Snapshot,
  type TruncatedList,
} from "./types";

export const DEFAULT_CHANGE_LIMIT = 50;
export const MAX_CHANGE_LIMIT = 200;

export interface ChangeFilters {
  actorKind?: (typeof ACTOR_KINDS)[number];
  /** The api token or mcp connection that acted. */
  tokenId?: string;
  entityType?: string;
  entityId?: string;
  /** Only entries older than this cursor (a `nextCursor` of an earlier page). */
  before?: string;
  limit?: number;
}

export interface ChangePage {
  items: ChangeEntry[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

const columns = {
  id: changeLog.id,
  seq: changeLog.seq,
  createdAt: changeLog.createdAt,
  actorKind: changeLog.actorKind,
  actorTokenId: changeLog.actorTokenId,
  actorLabel: changeLog.actorLabel,
  action: changeLog.action,
  entityType: changeLog.entityType,
  entityId: changeLog.entityId,
  summary: changeLog.summary,
  before: changeLog.before,
  after: changeLog.after,
  revertedAt: changeLog.revertedAt,
  revertedByEntryId: changeLog.revertedByEntryId,
  revertOfEntryId: changeLog.revertOfEntryId,
};

type Row = Omit<typeof changeLog.$inferSelect, "userId" | "updatedAt">;

export function toEntry(row: Row): ChangeEntry {
  return {
    id: row.id,
    seq: row.seq,
    at: row.createdAt.getTime(),
    actor: {
      kind: row.actorKind,
      tokenId: row.actorTokenId,
      label: row.actorLabel,
    },
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    before: (row.before as Snapshot | null) ?? null,
    after: (row.after as Snapshot | null) ?? null,
    revertedAt: row.revertedAt ? row.revertedAt.getTime() : null,
    revertedByEntryId: row.revertedByEntryId,
    revertOfEntryId: row.revertOfEntryId,
  };
}

/** Lists above `LIST_ARRAY_LIMIT` items become a `TruncatedList`, at any depth. */
function bounded(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > LIST_ARRAY_LIMIT) {
      return { count: value.length, truncated: true } satisfies TruncatedList;
    }
    return value.map(bounded);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, bounded(v)]),
    );
  }
  return value;
}

const boundedSnapshot = (s: Snapshot | null) =>
  s === null ? null : (bounded(s) as Snapshot);

/** The entry as a listing shows it: long lists in `before` / `after` replaced by their count. */
export function toListedEntry(row: Row): ChangeEntry {
  const entry = toEntry(row);
  return {
    ...entry,
    before: boundedSnapshot(entry.before),
    after: boundedSnapshot(entry.after),
  };
}

const cursorOf = (e: Pick<ChangeEntry, "seq" | "id">) => `${e.seq}:${e.id}`;

const cursorSchema = z
  .string()
  .regex(/^\d{1,16}:[0-9A-Za-z-]{1,64}$/)
  .transform((v) => {
    const i = v.indexOf(":");
    return { seq: Number(v.slice(0, i)), id: v.slice(i + 1) };
  });

const filtersSchema = z.object({
  actorKind: z.enum(ACTOR_KINDS).optional(),
  tokenId: z.string().min(1).max(100).optional(),
  entityType: z.string().min(1).max(100).optional(),
  entityId: z.string().min(1).max(100).optional(),
  before: cursorSchema.optional(),
  limit: z.number().int().min(1).max(MAX_CHANGE_LIMIT).optional(),
});

type Reader = Pick<DB, "select">;

/**
 * The user's changes, newest first, `limit` at a time (keyset pagination: pass
 * `nextCursor` back as `before`). Only the user's own entries are ever
 * returned. Lists inside `before` / `after` longer than `LIST_ARRAY_LIMIT` are
 * replaced by a `TruncatedList`; `getChange` has them whole. A malformed filter or cursor is an `invalid` LedgerError.
 */
export async function listChanges(
  userId: string,
  filters: ChangeFilters = {},
): Promise<ChangePage> {
  const parsed = filtersSchema.safeParse(filters);
  if (!parsed.success) {
    throw new LedgerError(
      "invalid",
      "That filter or page cursor is not valid.",
    );
  }
  const f = parsed.data;
  const limit = f.limit ?? DEFAULT_CHANGE_LIMIT;
  const rows = await getDB()
    .select(columns)
    .from(changeLog)
    .where(
      and(
        eq(changeLog.userId, userId),
        f.actorKind ? eq(changeLog.actorKind, f.actorKind) : undefined,
        f.tokenId ? eq(changeLog.actorTokenId, f.tokenId) : undefined,
        f.entityType ? eq(changeLog.entityType, f.entityType) : undefined,
        f.entityId ? eq(changeLog.entityId, f.entityId) : undefined,
        f.before
          ? or(
              lt(changeLog.seq, f.before.seq),
              and(
                eq(changeLog.seq, f.before.seq),
                lt(changeLog.id, f.before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(changeLog.seq), desc(changeLog.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(toListedEntry);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
  };
}

/** `getChange` on a transaction you already hold. */
export async function getChangeInTx(
  tx: Reader,
  userId: string,
  id: string,
): Promise<ChangeEntry> {
  const row = await first(
    tx
      .select(columns)
      .from(changeLog)
      .where(and(eq(changeLog.userId, userId), eq(changeLog.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Change");
  return toEntry(row);
}

export async function getChange(
  userId: string,
  id: string,
): Promise<ChangeEntry> {
  return await getChangeInTx(getDB(), userId, id);
}
