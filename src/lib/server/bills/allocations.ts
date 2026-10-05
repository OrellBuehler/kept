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
  afterCommit,
  first,
  transaction,
} from "$lib/server/db";
import { emitBillChanged } from "$lib/server/events";
import { LedgerError } from "$lib/server/ledger/errors";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import {
  getTransactionRowInTx,
  lockTransactionRowInTx,
} from "$lib/server/ledger/transactions";
import {
  billsLock,
  getBill,
  getBillInTx,
  toMatchBill,
  type BillView,
} from "./bills";
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

type AllocationTransaction = Awaited<ReturnType<typeof getTransactionRowInTx>>;
export type AllocationTx = Pick<DB, "select" | "insert" | "delete" | "update">;

/**
 * The transaction row to allocate against, read after taking its row lock: a
 * manual payment's edit (under the ledger lock) checks the allocations after
 * taking the same lock, so the two cannot both pass on stale reads.
 */
async function lockedTransactionRowInTx(
  tx: AllocationTx,
  userId: string,
  transactionId: string,
): Promise<AllocationTransaction> {
  await lockTransactionRowInTx(tx, userId, transactionId);
  return await getTransactionRowInTx(tx, userId, transactionId);
}

/**
 * Reads the bill and the transaction, validates against the existing
 * allocations and writes in one transaction, so a concurrent allocation cannot
 * slip between the check and the insert. `amountFor` runs on the bill read
 * inside the transaction (it may throw a LedgerError).
 */
async function allocateAtomically(
  userId: string,
  billId: string,
  transactionId: string,
  amountFor: (bill: BillView) => Minor,
  origin: AllocationOrigin,
): Promise<{ id: string }> {
  const created = await transaction(async (tx) => {
    const bill = await getBillInTx(tx, userId, billId);
    const amount = amountFor(bill);
    const row = await lockedTransactionRowInTx(tx, userId, transactionId);
    const allocated = await allocateRow(tx, userId, bill, row, amount, origin);
    afterCommit(() => emitBillChanged(userId, billId));
    return allocated;
    // The checks read every other allocation; under PostgreSQL two concurrent
    // allocations would both pass them without this lock.
  }, billsLock(userId));
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
 * `allocate` on a transaction you already hold, which must have been started
 * with `billsLock(userId)`: the checks read every other allocation. It does not announce
 * the change: the caller announces it with `afterCommit(() => emitBillChanged(...))`.
 */
export async function allocateInTx(
  tx: AllocationTx,
  userId: string,
  billId: string,
  transactionId: string,
  amount: Minor,
  origin: AllocationOrigin,
): Promise<{ id: string }> {
  const bill = await getBillInTx(tx, userId, billId);
  const row = await lockedTransactionRowInTx(tx, userId, transactionId);
  return await allocateRow(tx, userId, bill, row, amount, origin);
}

async function allocateRow(
  tx: AllocationTx,
  userId: string,
  bill: BillView,
  row: AllocationTransaction,
  amount: Minor,
  origin: AllocationOrigin,
): Promise<{ id: string }> {
  const billId = bill.id;
  const transactionId = row.id;
  if (row.source === "mirror") {
    throw new LedgerError(
      "invalid",
      "A mirrored transfer cannot be allocated to a bill.",
      "transactionId",
    );
  }
  const related: Allocation[] = await tx
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
    );
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
  const dismissal = and(
    eq(matchDismissals.userId, userId),
    eq(matchDismissals.billId, billId),
    eq(matchDismissals.transactionId, transactionId),
  );
  if (origin === "auto") {
    // A dismissal may have landed after the plan was computed; it wins.
    const dismissed = await first(
      tx
        .select({ id: matchDismissals.id })
        .from(matchDismissals)
        .where(dismissal)
        .limit(1),
    );
    if (dismissed) {
      throw new LedgerError(
        "conflict",
        "This pair was dismissed.",
        "transactionId",
      );
    }
  } else {
    // Allocating a pair that was dismissed means the user changed their mind.
    await tx.delete(matchDismissals).where(dismissal);
  }
  return (await first(
    tx
      .insert(billAllocations)
      .values({ userId, billId, transactionId, amount, origin })
      .returning({ id: billAllocations.id }),
  ))!;
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
