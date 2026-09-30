import { and, desc, eq, or, sql } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import { accounts, billAllocations, getDB, transactions } from "$lib/server/db";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import { getBill } from "./bills";
import { transactionDisplayColumns, type TransactionDisplay } from "./display";
import { computeBillStatus, type Allocation } from "./matching";
import { toMatchBill } from "./bills";

export const CANDIDATE_PAGE_SIZE = 20;

export interface CandidateTransaction extends TransactionDisplay {
  /** Unallocated part of the transaction, with the transaction's own sign. */
  unallocated: Minor;
  /** Amount to pre-fill, signed in the bill's direction (negative = refund). */
  suggestedAmount: Minor;
}

export interface CandidatePage {
  items: CandidateTransaction[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Transactions that could be allocated to the bill: same currency, something
 * left unallocated, not already allocated to this bill, and the right direction
 * (outgoing for invoices, incoming for credit notes). Incoming payments for an
 * invoice (and outgoing for a credit note) are offered only once something is
 * settled, as refunds. Searchable by counterparty, description, reference or amount.
 */
export function candidateTransactions(
  userId: string,
  billId: string,
  opts: { q?: string; page?: number; pageSize?: number } = {},
): CandidatePage {
  const bill = getBill(userId, billId);
  const db = getDB();
  const billAllocs: Allocation[] = db
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
      amount: billAllocations.amount,
    })
    .from(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        eq(billAllocations.billId, billId),
      ),
    )
    .all();
  const { settled, remaining } = computeBillStatus(
    toMatchBill(bill),
    billAllocs,
  );

  const pageSize = Math.max(
    1,
    Math.floor(opts.pageSize ?? CANDIDATE_PAGE_SIZE),
  );
  const requested = Math.max(1, Math.floor(opts.page ?? 1));
  const q = opts.q?.trim().slice(0, 200) ?? "";

  const primary =
    bill.kind === "invoice"
      ? sql`${transactions.amount} < 0`
      : sql`${transactions.amount} > 0`;
  const opposite =
    bill.kind === "invoice"
      ? sql`${transactions.amount} > 0`
      : sql`${transactions.amount} < 0`;
  const direction = settled > 0 ? or(primary, opposite) : primary;

  const used = sql`coalesce((select sum(abs(${billAllocations.amount})) from ${billAllocations} where ${billAllocations.transactionId} = ${transactions.id}), 0)`;
  const notOnBill = sql`not exists (select 1 from ${billAllocations} where ${billAllocations.transactionId} = ${transactions.id} and ${billAllocations.billId} = ${billId})`;

  let search;
  if (q !== "") {
    const pattern = `%${escapeLike(q)}%`;
    const amount = parseMoneyInput(q, bill.currency);
    search = or(
      sql`${transactions.counterpartyName} like ${pattern} escape '\\'`,
      sql`${transactions.description} like ${pattern} escape '\\'`,
      sql`${transactions.reference} like ${pattern} escape '\\'`,
      amount.ok
        ? sql`abs(${transactions.amount}) = ${Math.abs(amount.value)}`
        : undefined,
    );
  }

  const where = and(
    eq(transactions.userId, userId),
    sql`upper(${transactions.currency}) = ${bill.currency.toUpperCase()}`,
    direction,
    sql`${used} < abs(${transactions.amount})`,
    notOnBill,
    search,
  );

  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(where)
    .get()!.n;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pageCount);
  const rows = db
    .select({ ...transactionDisplayColumns, used })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(where)
    .orderBy(desc(transactions.bookingDate), desc(transactions.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const items = rows.map(({ used: usedAbs, ...tx }): CandidateTransaction => {
    const free = Math.abs(tx.amount) - Number(usedAbs);
    const unallocated = minor(tx.amount < 0 ? -free : free);
    const sameDirection =
      bill.kind === "invoice" ? tx.amount < 0 : tx.amount > 0;
    const suggestedAmount = sameDirection
      ? minor(remaining === null ? free : Math.min(remaining, free))
      : minor(-Math.min(free, settled));
    return {
      ...tx,
      unallocated,
      suggestedAmount:
        sameDirection && suggestedAmount === 0 ? minor(free) : suggestedAmount,
    };
  });
  return { items, total, page, pageSize, pageCount };
}
