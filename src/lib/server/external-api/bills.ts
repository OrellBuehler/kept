import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { BillKind, BillStatusName } from "$lib/bill-types";
import type { Minor } from "$lib/money";
import { billAllocations, bills, first, getDB } from "$lib/server/db";
import { todayLocal } from "$lib/server/bills/dates";
import { BILL_LIST_STATUSES, matchesStatus } from "$lib/server/bills/list";
import {
  billView,
  billViews,
  type BillWithStatus,
} from "$lib/server/bills/status";
import {
  dateParam,
  iso,
  notFoundError,
  pageInMemory,
  pagingQuery,
  type Page,
} from "./http";
import { billUrl } from "./urls";

export interface BillDto {
  id: string;
  kind: BillKind;
  creditorName: string | null;
  /** Minor units of `currency`; null for a bill without a fixed amount. Always positive when set. */
  amount: Minor | null;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  /** Derived from the allocated payments, exactly as the bill list shows it. */
  status: BillStatusName;
  /** Due before today and still unpaid. */
  overdue: boolean;
  /** Sum of the payments allocated to the bill, in the bill's direction. */
  paidAmount: Minor;
  /** Amount still to pay; null for a bill without a fixed amount. */
  remainingAmount: Minor | null;
  /** Latest booking date among the allocated payments. */
  lastPaymentDate: string | null;
  notes: string | null;
  url: string;
  /** Last change to the bill or to one of its allocations. */
  updatedAt: string;
}

const statusFilter = z
  .string()
  .max(200)
  .transform((v) => v.split(",").map((s) => s.trim()))
  .pipe(
    z.array(z.enum(BILL_LIST_STATUSES)).min(1).max(BILL_LIST_STATUSES.length),
  );

export const billsQuery = z.object({
  ...pagingQuery,
  status: statusFilter.optional(),
  dueFrom: dateParam.optional(),
  dueTo: dateParam.optional(),
});
export type BillsQuery = z.output<typeof billsQuery>;

/** When each bill's allocations last changed (allocating a payment does not touch the bill row). */
async function allocationTimes(
  userId: string,
  billId?: string,
): Promise<Map<string, Date>> {
  const rows = await getDB()
    .select({
      billId: billAllocations.billId,
      updatedAt: max(billAllocations.updatedAt),
    })
    .from(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        billId ? eq(billAllocations.billId, billId) : undefined,
      ),
    )
    .groupBy(billAllocations.billId);
  const out = new Map<string, Date>();
  for (const r of rows) if (r.updatedAt) out.set(r.billId, r.updatedAt);
  return out;
}

function toDto(
  v: BillWithStatus,
  allocationTime: Date | undefined,
  origin: string,
): BillDto {
  const updated = Math.max(v.updatedAt, allocationTime?.getTime() ?? 0);
  return {
    id: v.id,
    kind: v.kind,
    creditorName: v.creditorName,
    amount: v.amount,
    currency: v.currency,
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    invoiceNumber: v.invoiceNumber,
    status: v.status,
    overdue: v.overdue,
    paidAmount: v.settled,
    remainingAmount: v.remaining,
    lastPaymentDate: v.lastPaymentDate,
    notes: v.notes,
    url: billUrl(origin, v.id),
    updatedAt: iso(new Date(updated)),
  };
}

/** Bills by due date (earliest first, undated last). Status is computed in code, so filtering is too. */
export async function listBillDtos(
  userId: string,
  query: BillsQuery,
  origin: string,
  today: string = todayLocal(),
): Promise<Page<BillDto>> {
  const [views, times] = await Promise.all([
    billViews(userId, { today }),
    allocationTimes(userId),
  ]);
  const statuses = query.status;
  const dtos = views
    .filter((v) => !statuses || statuses.some((s) => matchesStatus(v, s)))
    .filter((v) => {
      if (query.dueFrom === undefined && query.dueTo === undefined) return true;
      if (v.dueDate === null) return false;
      return (
        (query.dueFrom === undefined || v.dueDate >= query.dueFrom) &&
        (query.dueTo === undefined || v.dueDate <= query.dueTo)
      );
    })
    .map((v) => toDto(v, times.get(v.id), origin))
    .filter(
      (d) =>
        query.updatedSince === undefined ||
        new Date(d.updatedAt) >= query.updatedSince,
    );
  return pageInMemory(dtos, (d) => [d.dueDate, d.id], {
    keyLength: 2,
    limit: query.limit,
    cursor: query.cursor,
  });
}

export async function getBillDto(
  userId: string,
  id: string,
  origin: string,
  today: string = todayLocal(),
): Promise<BillDto> {
  const owned = await first(
    getDB()
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.userId, userId), eq(bills.id, id)))
      .limit(1),
  );
  if (!owned) throw notFoundError("Bill");
  const [view, times] = await Promise.all([
    billView(userId, id, { today }),
    allocationTimes(userId, id),
  ]);
  return toDto(view, times.get(id), origin);
}
