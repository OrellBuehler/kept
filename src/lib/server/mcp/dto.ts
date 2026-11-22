import type { BillDto } from "$lib/server/external-api/bills";
import type { TransactionDetailDto } from "$lib/server/external-api/transactions";
import { decimal, decimalOrNull } from "./format";

/** A bill as the model sees it: amounts are decimal strings of `currency`. */
export function billOut(b: BillDto) {
  return {
    id: b.id,
    kind: b.kind,
    creditorName: b.creditorName,
    invoiceNumber: b.invoiceNumber,
    amount: decimalOrNull(b.amount, b.currency),
    currency: b.currency,
    issueDate: b.issueDate,
    dueDate: b.dueDate,
    status: b.status,
    overdue: b.overdue,
    paidAmount: decimal(b.paidAmount, b.currency),
    remainingAmount: decimalOrNull(b.remainingAmount, b.currency),
    lastPaymentDate: b.lastPaymentDate,
    notes: b.notes,
    url: b.url,
  };
}

/**
 * A payment (bank transaction) as the model sees it. Negative amounts are
 * outgoing. `billIds` (which bills it is allocated to) is bill data: it is
 * left out unless the connection may read bills.
 */
export function paymentOut(t: TransactionDetailDto, withBills = true) {
  return {
    id: t.id,
    accountId: t.accountId,
    bookingDate: t.bookingDate,
    amount: decimal(t.amount, t.currency),
    currency: t.currency,
    counterpartyName: t.counterpartyName,
    description: t.description,
    note: t.note,
    categoryId: t.categoryId,
    ...(withBills ? { billIds: t.billIds } : {}),
    url: t.url,
  };
}

/** What a connection that may change payments but not read them gets back: what it set. */
export function paymentChangeOut(t: TransactionDetailDto) {
  return { id: t.id, categoryId: t.categoryId, note: t.note };
}
