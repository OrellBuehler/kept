import { and, eq, gte, isNotNull, lt, lte, ne, notExists } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import type { BillKind } from "$lib/bill-types";
import { accounts, billAllocations, getDB, transactions } from "$lib/server/db";
import {
  billViews,
  groupBills,
  type BillWithStatus,
} from "$lib/server/bills/status";
import { getSuggestions } from "$lib/server/bills/suggestions";
import { addDays } from "./dates";

export interface BillBucket {
  count: number;
  /** One entry per currency that has at least one bill in the bucket. */
  totals: { currency: string; amount: Minor }[];
  /** Bills in the bucket without a fixed amount (they contribute 0 to the totals). */
  openAmountCount: number;
}

export interface UpcomingBill {
  id: string;
  kind: BillKind;
  creditorName: string | null;
  invoiceNumber: string | null;
  amount: Minor | null;
  /** Still to pay (null for open-amount bills). */
  remaining: Minor | null;
  currency: string;
  dueDate: string | null;
  dueInDays: number | null;
}

export interface BillsSummary {
  /** Unpaid and past the due date; totals are the amounts still to pay. */
  overdue: BillBucket;
  /** Unpaid and due within the next 14 days (not yet overdue). */
  dueSoon: BillBucket;
  /** Overpaid invoices and unsettled credit notes; totals are the amounts to get back. */
  awaitingRefund: BillBucket;
  /** The next 5 bills that are open and not overdue, earliest due date first (undated last). */
  upcoming: UpcomingBill[];
  /** Suggested bill/payment pairs waiting for confirmation (read-only, nothing is matched). */
  unmatchedSuggestions: number;
}

export const UPCOMING_LIMIT = 5;

function amountOf(bill: BillWithStatus, bucket: "pay" | "refund"): number {
  if (bucket === "pay") return bill.remaining ?? 0;
  if (bill.status === "overpaid") {
    return bill.amount === null ? 0 : Math.max(0, bill.settled - bill.amount);
  }
  return bill.remaining ?? 0;
}

function bucketOf(
  bills: readonly BillWithStatus[],
  kind: "pay" | "refund",
): BillBucket {
  const sums = new Map<string, number>();
  let openAmountCount = 0;
  for (const b of bills) {
    if (b.amount === null) openAmountCount += 1;
    sums.set(b.currency, (sums.get(b.currency) ?? 0) + amountOf(b, kind));
  }
  return {
    count: bills.length,
    totals: [...sums.keys()].sort().map((currency) => ({
      currency,
      amount: minor(sums.get(currency)!),
    })),
    openAmountCount,
  };
}

function toUpcoming(b: BillWithStatus): UpcomingBill {
  return {
    id: b.id,
    kind: b.kind,
    creditorName: b.creditorName,
    invoiceNumber: b.invoiceNumber,
    amount: b.amount,
    remaining: b.remaining,
    currency: b.currency,
    dueDate: b.dueDate,
    dueInDays: b.dueInDays,
  };
}

export async function billsSummary(
  userId: string,
  today: string,
): Promise<BillsSummary> {
  const groups = groupBills(await billViews(userId, { today }), { today });
  const upcoming = [...groups.dueSoon, ...groups.openOther]
    .sort((a, b) => {
      if (a.dueDate === b.dueDate) return a.id < b.id ? -1 : 1;
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    })
    .slice(0, UPCOMING_LIMIT)
    .map(toUpcoming);
  return {
    overdue: bucketOf(groups.overdue, "pay"),
    dueSoon: bucketOf(groups.dueSoon, "pay"),
    awaitingRefund: bucketOf(groups.awaitingRefund, "refund"),
    upcoming,
    unmatchedSuggestions: (await getSuggestions(userId)).length,
  };
}

/** Number of overdue bills (for the navigation badge). */
export async function overdueBillCount(
  userId: string,
  today: string,
): Promise<number> {
  return (await billViews(userId, { today })).filter((b) => b.overdue).length;
}

export interface UnmatchedHint {
  days: number;
  /** Outgoing payments with a QRR/SCOR reference that no bill is allocated to. */
  count: number;
}

/**
 * Outgoing transactions of the last `days` days (up to `today`) on
 * non-archived accounts that carry a QRR/SCOR reference but are not allocated
 * to any bill: likely bills that were never recorded.
 */
export async function unmatchedTransactions(
  userId: string,
  { days = 60, today }: { days?: number; today: string },
): Promise<UnmatchedHint> {
  const db = getDB();
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(accounts.archived, false),
        ne(transactions.source, "mirror"),
        lt(transactions.amount, minor(0)),
        isNotNull(transactions.referenceType),
        gte(transactions.bookingDate, addDays(today, -days)),
        lte(transactions.bookingDate, today),
        notExists(
          db
            .select({ one: billAllocations.id })
            .from(billAllocations)
            .where(
              and(
                eq(billAllocations.transactionId, transactions.id),
                eq(billAllocations.userId, userId),
              ),
            ),
        ),
      ),
    );
  return { days, count: rows.length };
}
