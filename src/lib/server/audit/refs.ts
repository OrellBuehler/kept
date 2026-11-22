import { and, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import {
  accounts,
  bills,
  categories,
  changeLog,
  getDB,
  institutions,
  transactions,
  type ActorKind,
} from "$lib/server/db";
import type { ChangeEntry } from "./types";

/** Snapshot fields that hold the id of another record, and what that record is. */
export const REFERENCE_FIELDS = {
  categoryId: "category",
  parentId: "category",
  accountId: "account",
  expectedAccountId: "account",
  billId: "bill",
  institutionId: "institution",
  transactionId: "transaction",
} as const;

export type ReferenceKind =
  (typeof REFERENCE_FIELDS)[keyof typeof REFERENCE_FIELDS];

/** Names of the records the entries point at, for showing a name where an id was stored. */
export interface ChangeReferences {
  categories: Record<string, string>;
  accounts: Record<string, { name: string; currency: string }>;
  bills: Record<string, { name: string | null; currency: string }>;
  institutions: Record<string, string>;
  transactions: Record<
    string,
    { name: string | null; bookingDate: string; currency: string }
  >;
}

const KIND_OF_ENTITY: Record<string, ReferenceKind | undefined> = {
  category: "category",
  account: "account",
  bill: "bill",
  institution: "institution",
};

/** Ids to look up, per kind: the entity of each entry and the reference fields of its before / after. */
export function collectReferenceIds(
  entries: readonly Pick<
    ChangeEntry,
    "entityType" | "entityId" | "before" | "after"
  >[],
): Record<ReferenceKind, Set<string>> {
  const ids: Record<ReferenceKind, Set<string>> = {
    category: new Set(),
    account: new Set(),
    bill: new Set(),
    institution: new Set(),
    transaction: new Set(),
  };
  for (const e of entries) {
    const own = KIND_OF_ENTITY[e.entityType];
    if (own) ids[own].add(e.entityId);
    for (const snap of [e.before, e.after]) {
      if (!snap) continue;
      for (const [key, kind] of Object.entries(REFERENCE_FIELDS)) {
        const v = snap[key];
        if (typeof v === "string" && v !== "") ids[kind].add(v);
      }
    }
  }
  return ids;
}

const CHUNK = 200;

async function byIds<T>(
  ids: Set<string>,
  read: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const all = [...ids];
  const out: T[] = [];
  for (let i = 0; i < all.length; i += CHUNK) {
    out.push(...(await read(all.slice(i, i + CHUNK))));
  }
  return out;
}

/**
 * The names behind the ids a page of entries mentions, one query per kind (not
 * per entry). Only the user's own records are looked up; a record that is gone
 * is simply absent.
 */
export async function resolveReferences(
  userId: string,
  entries: readonly ChangeEntry[],
): Promise<ChangeReferences> {
  const ids = collectReferenceIds(entries);
  const db = getDB();
  const [cats, accs, bls, insts, txs] = await Promise.all([
    byIds(ids.category, (c) =>
      db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.userId, userId), inArray(categories.id, c))),
    ),
    byIds(ids.account, (c) =>
      db
        .select({
          id: accounts.id,
          name: accounts.name,
          currency: accounts.currency,
        })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), inArray(accounts.id, c))),
    ),
    byIds(ids.bill, (c) =>
      db
        .select({
          id: bills.id,
          creditorName: bills.creditorName,
          invoiceNumber: bills.invoiceNumber,
          currency: bills.currency,
        })
        .from(bills)
        .where(and(eq(bills.userId, userId), inArray(bills.id, c))),
    ),
    byIds(ids.institution, (c) =>
      db
        .select({ id: institutions.id, name: institutions.name })
        .from(institutions)
        .where(
          and(eq(institutions.userId, userId), inArray(institutions.id, c)),
        ),
    ),
    byIds(ids.transaction, (c) =>
      db
        .select({
          id: transactions.id,
          counterpartyName: transactions.counterpartyName,
          bookingDate: transactions.bookingDate,
          currency: transactions.currency,
        })
        .from(transactions)
        .where(
          and(eq(transactions.userId, userId), inArray(transactions.id, c)),
        ),
    ),
  ]);
  return {
    categories: Object.fromEntries(cats.map((r) => [r.id, r.name])),
    accounts: Object.fromEntries(
      accs.map((r) => [r.id, { name: r.name, currency: r.currency }]),
    ),
    bills: Object.fromEntries(
      bls.map((r) => [
        r.id,
        { name: r.creditorName ?? r.invoiceNumber, currency: r.currency },
      ]),
    ),
    institutions: Object.fromEntries(insts.map((r) => [r.id, r.name])),
    transactions: Object.fromEntries(
      txs.map((r) => [
        r.id,
        {
          name: r.counterpartyName,
          bookingDate: r.bookingDate,
          currency: r.currency,
        },
      ]),
    ),
  };
}

export interface ChangeActorOption {
  kind: ActorKind;
  tokenId: string;
  /** The name the token or connection had when it last acted. */
  label: string | null;
}

/** Every token or connection that ever made a change of the user's, most recently active first, one row each. */
export async function listChangeActors(
  userId: string,
): Promise<ChangeActorOption[]> {
  const lastSeq = max(changeLog.seq).mapWith(Number);
  const rows = await getDB()
    .select({
      kind: changeLog.actorKind,
      tokenId: changeLog.actorTokenId,
      label: changeLog.actorLabel,
      lastSeq,
    })
    .from(changeLog)
    .where(and(eq(changeLog.userId, userId), isNotNull(changeLog.actorTokenId)))
    .groupBy(changeLog.actorKind, changeLog.actorTokenId, changeLog.actorLabel)
    .orderBy(desc(lastSeq), desc(changeLog.actorTokenId));
  const seen = new Map<string, ChangeActorOption>();
  for (const r of rows) {
    if (r.tokenId !== null && !seen.has(r.tokenId)) {
      seen.set(r.tokenId, { kind: r.kind, tokenId: r.tokenId, label: r.label });
    }
  }
  return [...seen.values()];
}
