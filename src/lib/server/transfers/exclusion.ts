import { and, eq, inArray, sql } from "drizzle-orm";
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
  /** Pass it when known: a mirror is never a contribution payment. */
  source?: string;
}

export interface TransferExclusion {
  /** Whether the row moves money between the user's own accounts and so is neither income nor an expense. */
  isTransfer(row: TransferRow): boolean;
}

/**
 * The one place that decides what counts as an own-account transfer for
 * income and expense totals. A row in a `linked` transfer is a transfer.
 * Rows that are not linked fall back to a heuristic: the counterparty IBAN is
 * the IBAN (or deposit or top-up IBAN) of another account of the user, archived
 * ones included, or an outgoing payment carries a pillar 3a portfolio's
 * deposit reference. A row the user unlinked (a `dismissed` transfer) is no
 * transfer to the IBAN heuristic either: "this is not a transfer" wins.
 */
export async function loadTransferExclusion(
  userId: string,
): Promise<TransferExclusion> {
  const db = getDB();
  const linked = new Set<string>();
  const dismissed = new Set<string>();
  for (const r of await db
    .select({
      out: transfers.outTransactionId,
      in: transfers.inTransactionId,
      status: transfers.status,
    })
    .from(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        inArray(transfers.status, ["linked", "dismissed"]),
      ),
    )) {
    const into = r.status === "linked" ? linked : dismissed;
    if (r.out) into.add(r.out);
    if (r.in) into.add(r.in);
  }
  // An IBAN can name several accounts: two accounts may be topped up through the same one.
  const ibanOwners = new Map<string, Set<string>>();
  const own = (iban: string, accountId: string) => {
    const key = normalizeIban(iban);
    const owners = ibanOwners.get(key);
    if (owners) owners.add(accountId);
    else ibanOwners.set(key, new Set([accountId]));
  };
  for (const a of await db
    .select({
      id: accounts.id,
      iban: accounts.iban,
      depositIban: accounts.depositIban,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))) {
    if (a.iban) own(a.iban, a.id);
    if (a.depositIban) own(a.depositIban, a.id);
  }
  const depositReferences = await portfolioDepositReferences(userId);
  return {
    isTransfer(row) {
      if (linked.has(row.id)) return true;
      if (row.counterpartyIban && !dismissed.has(row.id)) {
        const owners = ibanOwners.get(normalizeIban(row.counterpartyIban));
        if (owners && [...owners].some((id) => id !== row.accountId)) {
          return true;
        }
      }
      return (
        !dismissed.has(row.id) && isContributionPayment(depositReferences, row)
      );
    },
  };
}
