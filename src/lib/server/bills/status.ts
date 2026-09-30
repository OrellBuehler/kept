import { and, eq } from "drizzle-orm";
import type { Minor } from "$lib/money";
import { billAllocations, getDB, transactions } from "$lib/server/db";
import { getBill, listBills, toMatchBill, type BillView } from "./bills";
import {
  computeBillStatus,
  isOverdue,
  type Allocation,
  type BillStatus,
} from "./matching";

export const DUE_SOON_DAYS = 14;
export const RECENTLY_PAID_DAYS = 30;

export interface BillWithStatus extends BillView {
  status: BillStatus;
  /** Sum of the allocations in the bill's direction. */
  settled: Minor;
  /** null for open-amount bills; otherwise max(0, amount - settled). */
  remaining: Minor | null;
  /** Due before today and still unpaid. */
  overdue: boolean;
  /** Days from today to the due date (negative when past); null without a due date. */
  dueInDays: number | null;
  /** Latest booking date among the allocated transactions. */
  lastPaymentDate: string | null;
  allocationCount: number;
}

export interface BillGroups {
  overdue: BillWithStatus[];
  dueSoon: BillWithStatus[];
  awaitingRefund: BillWithStatus[];
  openOther: BillWithStatus[];
  recentlyPaid: BillWithStatus[];
  cancelled: BillWithStatus[];
}

export interface BillCounts {
  overdue: number;
  dueSoon: number;
  awaitingRefund: number;
  openOther: number;
  recentlyPaid: number;
  cancelled: number;
  /** Paid bills of any age. */
  paid: number;
  total: number;
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

interface AllocationRow extends Allocation {
  bookingDate: string;
}

function loadAllocationRows(userId: string, billId?: string): AllocationRow[] {
  return getDB()
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
      amount: billAllocations.amount,
      bookingDate: transactions.bookingDate,
    })
    .from(billAllocations)
    .innerJoin(transactions, eq(transactions.id, billAllocations.transactionId))
    .where(
      and(
        eq(billAllocations.userId, userId),
        billId ? eq(billAllocations.billId, billId) : undefined,
      ),
    )
    .all();
}

function withStatus(
  bill: BillView,
  allocations: readonly AllocationRow[],
  today: string,
): BillWithStatus {
  const mine = allocations.filter((a) => a.billId === bill.id);
  const { status, settled, remaining } = computeBillStatus(
    toMatchBill(bill),
    mine,
  );
  let last: string | null = null;
  for (const a of mine)
    if (last === null || a.bookingDate > last) last = a.bookingDate;
  return {
    ...bill,
    status,
    settled,
    remaining,
    overdue: isOverdue(bill, status, today),
    dueInDays: bill.dueDate === null ? null : daysBetween(today, bill.dueDate),
    lastPaymentDate: last,
    allocationCount: mine.length,
  };
}

/** Status is always derived from the current allocations, never stored. */
export function billViews(
  userId: string,
  { today }: { today: string },
): BillWithStatus[] {
  const allocations = loadAllocationRows(userId);
  return listBills(userId).map((b) => withStatus(b, allocations, today));
}

export function billView(
  userId: string,
  id: string,
  { today }: { today: string },
): BillWithStatus {
  const bill = getBill(userId, id);
  return withStatus(bill, loadAllocationRows(userId, id), today);
}

function byDue(a: BillWithStatus, b: BillWithStatus): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Puts every bill into exactly one group; paid bills older than 30 days are in none. */
export function groupBills(
  views: readonly BillWithStatus[],
  { today }: { today: string },
): BillGroups {
  const groups: BillGroups = {
    overdue: [],
    dueSoon: [],
    awaitingRefund: [],
    openOther: [],
    recentlyPaid: [],
    cancelled: [],
  };
  for (const v of views) {
    if (v.status === "cancelled") groups.cancelled.push(v);
    else if (
      v.status === "credit_due" ||
      (v.status === "overpaid" && v.kind === "invoice")
    ) {
      groups.awaitingRefund.push(v);
    } else if (v.overdue) groups.overdue.push(v);
    else if (v.status === "open" || v.status === "partially_paid") {
      if (v.dueInDays !== null && v.dueInDays <= DUE_SOON_DAYS) {
        groups.dueSoon.push(v);
      } else groups.openOther.push(v);
    } else if (v.status === "paid") {
      if (
        v.lastPaymentDate !== null &&
        daysBetween(v.lastPaymentDate, today) <= RECENTLY_PAID_DAYS
      ) {
        groups.recentlyPaid.push(v);
      }
    } else groups.openOther.push(v);
  }
  groups.overdue.sort(byDue);
  groups.dueSoon.sort(byDue);
  groups.openOther.sort(byDue);
  groups.awaitingRefund.sort(byDue);
  groups.recentlyPaid.sort((a, b) =>
    (b.lastPaymentDate ?? "").localeCompare(a.lastPaymentDate ?? ""),
  );
  groups.cancelled.sort((a, b) => b.createdAt - a.createdAt);
  return groups;
}

export function countBills(
  views: readonly BillWithStatus[],
  groups: BillGroups,
): BillCounts {
  return {
    overdue: groups.overdue.length,
    dueSoon: groups.dueSoon.length,
    awaitingRefund: groups.awaitingRefund.length,
    openOther: groups.openOther.length,
    recentlyPaid: groups.recentlyPaid.length,
    cancelled: groups.cancelled.length,
    paid: views.filter((v) => v.status === "paid").length,
    total: views.length,
  };
}
