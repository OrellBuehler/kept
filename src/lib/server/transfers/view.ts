import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TransferMethod } from "$lib/ledger-types";
import { accounts, getDB, transactions, transfers } from "$lib/server/db";

/** The transfer a transaction belongs to; dismissed transfers are not shown. */
export interface TransferRef {
  id: string;
  /** `needs_amount`: the other side is not booked yet (FX transfer waiting for the received amount). */
  status: "linked" | "needs_amount";
  method: TransferMethod;
  /** Which side of the transfer this transaction is. */
  direction: "out" | "in";
  peerAccountId: string;
  peerAccountName: string;
  /** Null while `needs_amount`. */
  peerTransactionId: string | null;
}

/** The transaction a mirror was created from. */
export interface MirrorRef {
  transactionId: string;
  accountId: string;
  accountName: string;
  /** An imported statement of the account covers this date (its period, or its balance dates), but no real row replaced the mirror. */
  noBankCounterpart: boolean;
}

const CHUNK = 400;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK)
    out.push(list.slice(i, i + CHUNK));
  return out;
}

export function transferRefs(
  userId: string,
  transactionIds: readonly string[],
): Map<string, TransferRef> {
  const out = new Map<string, TransferRef>();
  if (transactionIds.length === 0) return out;
  const db = getDB();
  const names = new Map(
    db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
      .map((a) => [a.id, a.name]),
  );
  for (const ids of chunks(transactionIds)) {
    const rows = db
      .select()
      .from(transfers)
      .where(
        and(
          eq(transfers.userId, userId),
          sql`${transfers.status} != 'dismissed'`,
          or(
            inArray(transfers.outTransactionId, ids),
            inArray(transfers.inTransactionId, ids),
          ),
        ),
      )
      .all();
    const wanted = new Set(ids);
    for (const r of rows) {
      const status = r.status === "needs_amount" ? "needs_amount" : "linked";
      const sides: [string | null, "out" | "in"][] = [
        [r.outTransactionId, "out"],
        [r.inTransactionId, "in"],
      ];
      for (const [id, direction] of sides) {
        if (id === null || !wanted.has(id)) continue;
        const outgoing = direction === "out";
        const peerAccountId = outgoing ? r.toAccountId : r.fromAccountId;
        out.set(id, {
          id: r.id,
          status,
          method: r.method,
          direction,
          peerAccountId,
          peerAccountName: names.get(peerAccountId) ?? "",
          peerTransactionId: outgoing ? r.inTransactionId : r.outTransactionId,
        });
      }
    }
  }
  return out;
}

export function mirrorRefs(
  userId: string,
  mirrors: readonly { id: string; mirrorOfId: string | null }[],
): Map<string, MirrorRef> {
  const out = new Map<string, MirrorRef>();
  const withSource = mirrors.filter(
    (m): m is { id: string; mirrorOfId: string } => m.mirrorOfId !== null,
  );
  if (withSource.length === 0) return out;
  const db = getDB();
  const sourceOf = new Map<
    string,
    { transactionId: string; accountId: string; accountName: string }
  >();
  const sourceIds = [...new Set(withSource.map((m) => m.mirrorOfId))];
  for (const ids of chunks(sourceIds)) {
    for (const s of db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        accountName: accounts.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(eq(transactions.userId, userId), inArray(transactions.id, ids)),
      )
      .all()) {
      sourceOf.set(s.id, {
        transactionId: s.id,
        accountId: s.accountId,
        accountName: s.accountName,
      });
    }
  }
  const uncovered = new Set<string>();
  for (const ids of chunks(withSource.map((m) => m.id))) {
    for (const r of db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, ids),
          sql`exists (select 1 from imports where imports.account_id = ${transactions.accountId} and coalesce(min(imports.statement_from, imports.opening_balance_date), imports.statement_from, imports.opening_balance_date) <= ${transactions.bookingDate} and coalesce(max(imports.statement_to, imports.closing_balance_date), imports.statement_to, imports.closing_balance_date) >= ${transactions.bookingDate})`,
        ),
      )
      .all()) {
      uncovered.add(r.id);
    }
  }
  for (const m of withSource) {
    const source = sourceOf.get(m.mirrorOfId);
    if (!source) continue;
    out.set(m.id, { ...source, noBankCounterpart: uncovered.has(m.id) });
  }
  return out;
}
