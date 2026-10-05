import { minor } from "$lib/money";
import { billViews, type BillWithStatus } from "$lib/server/bills/status";
import type { ProjectedItem } from "./projection";

export const BILL_SOURCE = "bill";

export type ForecastBill = Pick<
  BillWithStatus,
  | "id"
  | "kind"
  | "status"
  | "amount"
  | "remaining"
  | "currency"
  | "dueDate"
  | "creditorName"
  | "invoiceNumber"
  | "expectedAccountId"
>;

function isPayable(b: ForecastBill): boolean {
  return (
    b.kind === "invoice" &&
    (b.status === "open" || b.status === "partially_paid")
  );
}

/**
 * Outflows for unpaid invoices: the open amount (partial payments already
 * deducted) on the due date, or on `from` when the due date has passed.
 * Credit notes, open-amount bills and bills without a due date are not
 * projected (see `unprojectedBills`).
 */
export function billsToItems(
  bills: readonly ForecastBill[],
  from: string,
): ProjectedItem[] {
  const items: ProjectedItem[] = [];
  for (const b of bills) {
    if (!isPayable(b) || b.dueDate === null) continue;
    if (b.remaining === null || b.remaining <= 0) continue;
    items.push({
      date: b.dueDate < from ? from : b.dueDate,
      amount: minor(-b.remaining),
      currency: b.currency,
      accountId: b.expectedAccountId,
      source: BILL_SOURCE,
      label: b.creditorName ?? b.invoiceNumber ?? "Bill",
      ref: b.id,
    });
  }
  return items;
}

export interface UnprojectedBills {
  noDueDate: number;
  noAmount: number;
}

/** Unpaid invoices that could not be projected, by reason. */
export function unprojectedBills(
  bills: readonly ForecastBill[],
): UnprojectedBills {
  let noDueDate = 0;
  let noAmount = 0;
  for (const b of bills) {
    if (!isPayable(b)) continue;
    if (b.amount === null) noAmount += 1;
    else if (b.dueDate === null) noDueDate += 1;
  }
  return { noDueDate, noAmount };
}

export function loadBills(
  userId: string,
  today: string,
): Promise<BillWithStatus[]> {
  return billViews(userId, { today });
}
