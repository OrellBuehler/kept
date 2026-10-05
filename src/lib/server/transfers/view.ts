import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TransferMethod } from "$lib/ledger-types";
import {
  accounts,
  getDB,
  imports,
  transactions,
  transfers,
} from "$lib/server/db";

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

export async function transferRefs(
  userId: string,
  transactionIds: readonly string[],
): Promise<Map<string, TransferRef>> {
  const out = new Map<string, TransferRef>();
  if (transactionIds.length === 0) return out;
  const db = getDB();
  const names = new Map(
    (
      await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.userId, userId))
    ).map((a) => [a.id, a.name]),
  );
  for (const ids of chunks(transactionIds)) {
    const rows = await db
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
      );
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

export async function mirrorRefs(
  userId: string,
  mirrors: readonly { id: string; mirrorOfId: string | null }[],
): Promise<Map<string, MirrorRef>> {
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
    for (const s of await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        accountName: accounts.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(eq(transactions.userId, userId), inArray(transactions.id, ids)),
      )) {
      sourceOf.set(s.id, {
        transactionId: s.id,
        accountId: s.accountId,
        accountName: s.accountName,
      });
    }
  }
  const insideImportedPeriod = new Set<string>();
  for (const ids of chunks(withSource.map((m) => m.id))) {
    for (const r of await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, ids),
          // The earliest of the statement start and the opening balance date is
          // <= the booking date when either one is, and likewise for the end:
          // no scalar min()/max(), which only SQLite has.
          sql`exists (select 1 from ${imports} where ${imports.accountId} = ${transactions.accountId} and (${imports.statementFrom} <= ${transactions.bookingDate} or ${imports.openingBalanceDate} <= ${transactions.bookingDate}) and (${imports.statementTo} >= ${transactions.bookingDate} or ${imports.closingBalanceDate} >= ${transactions.bookingDate}))`,
        ),
      )) {
      insideImportedPeriod.add(r.id);
    }
  }
  for (const m of withSource) {
    const source = sourceOf.get(m.mirrorOfId);
    if (!source) continue;
    out.set(m.id, {
      ...source,
      noBankCounterpart: insideImportedPeriod.has(m.id),
    });
  }
  return out;
}
