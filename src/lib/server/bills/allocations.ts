import { and, desc, eq, or } from "drizzle-orm";
import type { AllocationOrigin } from "$lib/bill-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  billAllocations,
  getDB,
  matchDismissals,
  transactions,
} from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import { getTransaction } from "$lib/server/ledger/transactions";
import { getBill, toMatchBill } from "./bills";
import { transactionDisplayColumns, type TransactionDisplay } from "./display";
import {
  validateAllocation,
  type Allocation,
  type MatchTransaction,
} from "./matching";

export interface AllocationView {
  id: string;
  billId: string;
  amount: Minor;
  origin: AllocationOrigin;
  createdAt: number;
  transaction: TransactionDisplay;
}

export function toMatchTransaction(tx: {
  id: string;
  bookingDate: string;
  amount: Minor;
  currency: string;
  reference: string | null;
  counterpartyIban: string | null;
  counterpartyName: string | null;
}): MatchTransaction {
  return {
    id: tx.id,
    bookingDate: tx.bookingDate,
    amount: tx.amount,
    currency: tx.currency,
    reference: tx.reference,
    counterpartyIban: tx.counterpartyIban,
    counterpartyName: tx.counterpartyName,
  };
}

/** Every allocation of the user; the engine needs them across all bills. */
export function loadAllocations(userId: string): Allocation[] {
  return getDB()
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
      amount: billAllocations.amount,
    })
    .from(billAllocations)
    .where(eq(billAllocations.userId, userId))
    .all();
}

/**
 * Allocates (part of) a transaction to a bill. The amount is signed in the bill's
 * direction; the pure engine validates it against the bill and every other
 * allocation of the transaction.
 */
export function allocate(
  userId: string,
  billId: string,
  transactionId: string,
  amount: Minor,
  origin: AllocationOrigin,
): { id: string } {
  const bill = getBill(userId, billId);
  const tx = getTransaction(userId, transactionId);
  const related: Allocation[] = getDB()
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
      amount: billAllocations.amount,
    })
    .from(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        or(
          eq(billAllocations.billId, billId),
          eq(billAllocations.transactionId, transactionId),
        ),
      ),
    )
    .all();
  if (
    related.some(
      (a) => a.billId === billId && a.transactionId === transactionId,
    )
  ) {
    throw new LedgerError(
      "conflict",
      "This payment is already allocated to the bill.",
      "transactionId",
    );
  }
  const problem = validateAllocation(
    toMatchBill(bill),
    toMatchTransaction(tx),
    amount,
    related,
  );
  if (problem !== null) throw new LedgerError("invalid", problem, "amount");
  const db = getDB();
  // Allocating a pair that was dismissed means the user changed their mind.
  db.delete(matchDismissals)
    .where(
      and(
        eq(matchDismissals.userId, userId),
        eq(matchDismissals.billId, billId),
        eq(matchDismissals.transactionId, transactionId),
      ),
    )
    .run();
  return db
    .insert(billAllocations)
    .values({ userId, billId, transactionId, amount, origin })
    .returning({ id: billAllocations.id })
    .get();
}

/** Like `allocate`, with the amount typed in the bill's currency (may be negative for refunds). */
export function allocateFromInput(
  userId: string,
  billId: string,
  transactionId: string,
  amountText: string,
  origin: AllocationOrigin,
): { id: string } {
  const bill = getBill(userId, billId);
  const parsed = parseMoneyInput(amountText, bill.currency);
  if (!parsed.ok) throw new LedgerError("invalid", parsed.message, "amount");
  return allocate(userId, billId, transactionId, parsed.value, origin);
}

export function listBillAllocations(
  userId: string,
  billId: string,
): AllocationView[] {
  getBill(userId, billId);
  return getDB()
    .select({
      allocationId: billAllocations.id,
      allocationAmount: billAllocations.amount,
      origin: billAllocations.origin,
      allocatedAt: billAllocations.createdAt,
      tx: transactionDisplayColumns,
    })
    .from(billAllocations)
    .innerJoin(transactions, eq(transactions.id, billAllocations.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(billAllocations.userId, userId),
        eq(transactions.userId, userId),
        eq(billAllocations.billId, billId),
      ),
    )
    .orderBy(desc(transactions.bookingDate), desc(billAllocations.createdAt))
    .all()
    .map((r) => ({
      id: r.allocationId,
      billId,
      amount: r.allocationAmount,
      origin: r.origin,
      createdAt: r.allocatedAt.getTime(),
      transaction: r.tx,
    }));
}
