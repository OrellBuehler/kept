import { and, desc, eq, or } from "drizzle-orm";
import type { AllocationOrigin } from "$lib/bill-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  billAllocations,
  getDB,
  matchDismissals,
  transactions,
  type DB,
} from "$lib/server/db";
import { emitBillChanged } from "$lib/server/events";
import { LedgerError } from "$lib/server/ledger/errors";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import { getTransactionRowInTx } from "$lib/server/ledger/transactions";
import { getBill, getBillInTx, toMatchBill, type BillView } from "./bills";
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
export function loadAllocations(userId: string): Promise<Allocation[]> {
  return getDB()
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
      amount: billAllocations.amount,
    })
    .from(billAllocations)
    .where(eq(billAllocations.userId, userId));
}

type AllocationTransaction = ReturnType<typeof getTransactionRowInTx>;
type AllocationTx = Pick<DB, "select" | "insert" | "delete">;

/**
 * Reads the bill and the transaction, validates against the existing
 * allocations and writes in one transaction, so a concurrent allocation cannot
 * slip between the check and the insert. `amountFor` runs on the bill read
 * inside the transaction (it may throw a LedgerError).
 */
function allocateAtomically(
  userId: string,
  billId: string,
  transactionId: string,
  amountFor: (bill: BillView) => Minor,
  origin: AllocationOrigin,
): { id: string } {
  const created = getDB().transaction((tx) => {
    const bill = getBillInTx(tx, userId, billId);
    const amount = amountFor(bill);
    const row = getTransactionRowInTx(tx, userId, transactionId);
    return allocateRow(tx, userId, bill, row, amount, origin);
  });
  emitBillChanged(userId, billId);
  return created;
}

/**
 * Allocates (part of) a transaction to a bill. The amount is signed in the bill's
 * direction; the pure engine validates it against the bill and every other
 * allocation of the transaction.
 */
export async function allocate(
  userId: string,
  billId: string,
  transactionId: string,
  amount: Minor,
  origin: AllocationOrigin,
): Promise<{ id: string }> {
  return allocateAtomically(
    userId,
    billId,
    transactionId,
    () => amount,
    origin,
  );
}

/**
 * Sync twin of `allocate`, for the body of a transaction. It does not announce
 * the change: the caller emits `emitBillChanged` once the transaction committed.
 */
export function allocateInTx(
  tx: AllocationTx,
  userId: string,
  billId: string,
  transactionId: string,
  amount: Minor,
  origin: AllocationOrigin,
): { id: string } {
  const bill = getBillInTx(tx, userId, billId);
  const row = getTransactionRowInTx(tx, userId, transactionId);
  return allocateRow(tx, userId, bill, row, amount, origin);
}

function allocateRow(
  tx: AllocationTx,
  userId: string,
  bill: BillView,
  row: AllocationTransaction,
  amount: Minor,
  origin: AllocationOrigin,
): { id: string } {
  const billId = bill.id;
  const transactionId = row.id;
  if (row.source === "mirror") {
    throw new LedgerError(
      "invalid",
      "A mirrored transfer cannot be allocated to a bill.",
      "transactionId",
    );
  }
  const related: Allocation[] = tx
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
    toMatchTransaction(row),
    amount,
    related,
  );
  if (problem !== null) throw new LedgerError("invalid", problem, "amount");
  // Allocating a pair that was dismissed means the user changed their mind.
  tx.delete(matchDismissals)
    .where(
      and(
        eq(matchDismissals.userId, userId),
        eq(matchDismissals.billId, billId),
        eq(matchDismissals.transactionId, transactionId),
      ),
    )
    .run();
  return tx
    .insert(billAllocations)
    .values({ userId, billId, transactionId, amount, origin })
    .returning({ id: billAllocations.id })
    .get();
}

/** Like `allocate`, with the amount typed in the bill's currency (may be negative for refunds). */
export async function allocateFromInput(
  userId: string,
  billId: string,
  transactionId: string,
  amountText: string,
  origin: AllocationOrigin,
): Promise<{ id: string }> {
  return allocateAtomically(
    userId,
    billId,
    transactionId,
    (bill) => {
      const parsed = parseMoneyInput(amountText, bill.currency);
      if (!parsed.ok)
        throw new LedgerError("invalid", parsed.message, "amount");
      return parsed.value;
    },
    origin,
  );
}

export async function listBillAllocations(
  userId: string,
  billId: string,
): Promise<AllocationView[]> {
  await getBill(userId, billId);
  const rows = await getDB()
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
    .orderBy(desc(transactions.bookingDate), desc(billAllocations.createdAt));
  return rows.map((r) => ({
    id: r.allocationId,
    billId,
    amount: r.allocationAmount,
    origin: r.origin,
    createdAt: r.allocatedAt.getTime(),
    transaction: r.tx,
  }));
}
