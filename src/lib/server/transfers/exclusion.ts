import { and, eq, sql } from "drizzle-orm";
import { normalizeIban } from "$lib/iban";
import { accounts, getDB, transactions, transfers } from "$lib/server/db";
import {
  isContributionPayment,
  portfolioDepositReferences,
} from "$lib/server/pillar3a/transfers";

/** SQL condition: the transaction is not on either side of a linked transfer. */
export const notInLinkedTransfer = sql`not exists (select 1 from ${transfers} where ${transfers.status} = 'linked' and (${transfers.outTransactionId} = ${transactions.id} or ${transfers.inTransactionId} = ${transactions.id}))`;

export interface TransferRow {
  id: string;
  accountId: string;
  amount: number;
  currency: string;
  reference: string | null;
  counterpartyIban: string | null;
}

export interface TransferExclusion {
  /** Whether the row moves money between the user's own accounts and so is neither income nor an expense. */
  isTransfer(row: TransferRow): boolean;
}

/**
 * The one place that decides what counts as an own-account transfer for
 * income and expense totals. A row in a `linked` transfer is a transfer.
 * Rows that are not linked fall back to a heuristic: the counterparty IBAN is
 * the IBAN (or pillar 3a deposit IBAN) of another account of the user, archived
 * ones included, or an outgoing payment carries a pillar 3a portfolio's
 * deposit reference.
 */
export function loadTransferExclusion(userId: string): TransferExclusion {
  const db = getDB();
  const linked = new Set<string>();
  for (const r of db
    .select({
      out: transfers.outTransactionId,
      in: transfers.inTransactionId,
    })
    .from(transfers)
    .where(and(eq(transfers.userId, userId), eq(transfers.status, "linked")))
    .all()) {
    if (r.out) linked.add(r.out);
    if (r.in) linked.add(r.in);
  }
  const ibanOwner = new Map<string, string>();
  for (const a of db
    .select({
      id: accounts.id,
      iban: accounts.iban,
      depositIban: accounts.depositIban,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all()) {
    if (a.iban) ibanOwner.set(normalizeIban(a.iban), a.id);
    if (a.depositIban) ibanOwner.set(normalizeIban(a.depositIban), a.id);
  }
  const depositReferences = portfolioDepositReferences(userId);
  return {
    isTransfer(row) {
      if (linked.has(row.id)) return true;
      if (row.counterpartyIban) {
        const owner = ibanOwner.get(normalizeIban(row.counterpartyIban));
        if (owner !== undefined && owner !== row.accountId) return true;
      }
      return isContributionPayment(depositReferences, row);
    },
  };
}
