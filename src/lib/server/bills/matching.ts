import { normalizeIban } from "$lib/iban";
import { minor, type Minor } from "$lib/money";
import { normalizeReference } from "$lib/references";

export type BillKind = "invoice" | "credit_note";
export type ReferenceType = "QRR" | "SCOR" | "NON";

export interface MatchBill {
  id: string;
  kind: BillKind;
  currency: string;
  /** null = open-amount bill; always positive when set */
  amount: Minor | null;
  issueDate: string | null;
  dueDate: string | null;
  reference: string | null;
  referenceType: ReferenceType | null;
  creditorIban: string | null;
  creditorName: string | null;
  cancelled: boolean;
}

export interface MatchTransaction {
  id: string;
  bookingDate: string;
  /** signed from the account holder's view: outgoing is negative */
  amount: Minor;
  currency: string;
  reference: string | null;
  counterpartyIban: string | null;
  counterpartyName: string | null;
}

export interface Allocation {
  billId: string;
  transactionId: string;
  /** signed in the bill's direction: positive settles the bill, negative undoes */
  amount: Minor;
}

export type BillStatus =
  "open" | "paid" | "overpaid" | "partially_paid" | "credit_due" | "cancelled";

export interface BillStatusResult {
  status: BillStatus;
  settled: Minor;
  /** null for open-amount bills; otherwise max(0, amount - settled) */
  remaining: Minor | null;
}

export type MatchRule = "reference" | "iban_amount";

export interface Suggestion {
  billId: string;
  transactionId: string;
  rule: MatchRule;
  confidence: "exact" | "high";
  /** signed in the bill's direction (negative for refunds of an overpayment) */
  amount: Minor;
  ambiguous: boolean;
}

export interface MatchOptions {
  /** days before the issue date in which a payment is still accepted */
  daysBeforeIssue: number;
  /** assumed payment term when only one of issue/due date is known */
  defaultTermDays: number;
  /** days after the due date in which a payment is still accepted */
  daysAfterDue: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  daysBeforeIssue: 5,
  defaultTermDays: 60,
  daysAfterDue: 45,
};

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10) === value;
}

function sameCurrency(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** The allocation amount a transaction contributes to a bill (currency is not checked). */
export function billDirectionAmount(
  bill: Pick<MatchBill, "kind">,
  tx: Pick<MatchTransaction, "amount">,
): Minor {
  return minor(bill.kind === "invoice" ? 0 - tx.amount : tx.amount);
}

export function computeBillStatus(
  bill: MatchBill,
  allocations: readonly Allocation[],
  // Overdue is a UI property (see isOverdue); status does not depend on today.
  _today?: string,
): BillStatusResult {
  let total = 0;
  for (const a of allocations) if (a.billId === bill.id) total += a.amount;
  const settled = minor(total);
  const remaining =
    bill.amount === null ? null : minor(Math.max(0, bill.amount - settled));

  if (bill.cancelled) return { status: "cancelled", settled, remaining };

  if (bill.amount === null) {
    const status: BillStatus =
      settled > 0 ? "paid" : bill.kind === "invoice" ? "open" : "credit_due";
    return { status, settled, remaining };
  }
  if (bill.kind === "invoice") {
    const status: BillStatus =
      settled <= 0
        ? "open"
        : settled < bill.amount
          ? "partially_paid"
          : settled === bill.amount
            ? "paid"
            : "overpaid";
    return { status, settled, remaining };
  }
  const status: BillStatus =
    settled < bill.amount
      ? "credit_due"
      : settled === bill.amount
        ? "paid"
        : "overpaid";
  return { status, settled, remaining };
}

/** Overdue is a UI property: due strictly before today and still unpaid. */
export function isOverdue(
  bill: Pick<MatchBill, "dueDate">,
  status: BillStatus,
  today: string,
): boolean {
  return (
    bill.dueDate !== null &&
    bill.dueDate < today &&
    (status === "open" || status === "partially_paid")
  );
}

/**
 * The part of a transaction not yet allocated, carrying the transaction's own sign
 * (outgoing negative). Every valid allocation consumes |allocation| of |transaction|.
 */
export function unallocatedAmount(
  tx: Pick<MatchTransaction, "id" | "amount">,
  allocations: readonly Allocation[],
): Minor {
  let used = 0;
  for (const a of allocations) {
    if (a.transactionId === tx.id) used += Math.abs(a.amount);
  }
  const free = Math.max(0, Math.abs(tx.amount) - used);
  return minor(tx.amount < 0 ? 0 - free : free);
}

export function validateAllocation(
  bill: MatchBill,
  tx: MatchTransaction,
  amount: Minor,
  allocations: readonly Allocation[],
): string | null {
  if (bill.cancelled) return "Bill is cancelled";
  if (!sameCurrency(bill.currency, tx.currency)) {
    return "Currency of bill and transaction differ";
  }
  if (amount === 0) return "Amount must not be zero";
  const direction = Math.sign(billDirectionAmount(bill, tx));
  if (direction === 0 || Math.sign(amount) !== direction) {
    return bill.kind === "invoice"
      ? "Invoices are settled by outgoing payments; a refund must be negative"
      : "Credit notes are settled by incoming payments; a reversal must be negative";
  }
  if (Math.abs(amount) > Math.abs(unallocatedAmount(tx, allocations))) {
    return "Amount exceeds the unallocated part of the transaction";
  }
  if (amount < 0 && computeBillStatus(bill, allocations).settled + amount < 0) {
    return "Refund exceeds the amount settled on the bill";
  }
  return null;
}

function paymentWindow(
  bill: MatchBill,
  o: MatchOptions,
): { from: string; to: string } | null {
  const { issueDate, dueDate } = bill;
  if (issueDate === null && dueDate === null) return null;
  if (
    (issueDate !== null && !isIsoDate(issueDate)) ||
    (dueDate !== null && !isIsoDate(dueDate))
  ) {
    return null;
  }
  const start = issueDate ?? addDays(dueDate as string, -o.defaultTermDays);
  const end = dueDate ?? addDays(issueDate as string, o.defaultTermDays);
  return {
    from: addDays(start, -o.daysBeforeIssue),
    to: addDays(end, o.daysAfterDue),
  };
}

function markAmbiguous(list: Suggestion[]): void {
  const byBill = new Map<string, number>();
  const byTx = new Map<string, number>();
  for (const s of list) {
    byBill.set(s.billId, (byBill.get(s.billId) ?? 0) + 1);
    byTx.set(s.transactionId, (byTx.get(s.transactionId) ?? 0) + 1);
  }
  for (const s of list) {
    if (
      (byBill.get(s.billId) ?? 0) > 1 ||
      (byTx.get(s.transactionId) ?? 0) > 1
    ) {
      s.ambiguous = true;
    }
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Suggests bill/transaction pairs. Nothing is written; the caller decides.
 *
 * Instalments paid under one reference are flagged ambiguous on purpose: several
 * transactions carrying the same reference for one bill need the user's confirmation
 * rather than automatic allocation. Ambiguity is also raised when a bill has both a
 * reference and an IBAN+amount suggestion.
 */
export function suggestMatches(
  bills: readonly MatchBill[],
  transactions: readonly MatchTransaction[],
  allocations: readonly Allocation[],
  options: Partial<MatchOptions> = {},
): Suggestion[] {
  const o: MatchOptions = { ...DEFAULT_MATCH_OPTIONS, ...options };

  const allocated = new Set(
    allocations.map((a) => `${a.billId}\u0000${a.transactionId}`),
  );

  const free = transactions
    .map((tx) => ({ tx, free: unallocatedAmount(tx, allocations) }))
    .filter((t) => t.free !== 0);

  interface OpenBill {
    bill: MatchBill;
    settled: Minor;
    remaining: Minor | null;
    overpaid: boolean;
    wantsIncoming: boolean;
  }
  const open: OpenBill[] = [];
  for (const bill of bills) {
    const { status, settled, remaining } = computeBillStatus(bill, allocations);
    const overpaid = status === "overpaid" && bill.kind === "invoice";
    if (
      overpaid ||
      status === "open" ||
      status === "partially_paid" ||
      status === "credit_due"
    ) {
      open.push({
        bill,
        settled,
        remaining,
        overpaid,
        wantsIncoming: overpaid || bill.kind === "credit_note",
      });
    }
  }

  const rule1: Suggestion[] = [];
  const rule2: Suggestion[] = [];

  // Pass 1: structured references.
  const consumed = new Map<string, number>();
  for (const { bill, remaining, overpaid, wantsIncoming } of open) {
    if (overpaid) continue;
    const billRef =
      bill.reference !== null &&
      (bill.referenceType === "QRR" || bill.referenceType === "SCOR")
        ? normalizeReference(bill.reference)
        : "";
    if (billRef === "") continue;
    for (const { tx, free: txFree } of free) {
      if (allocated.has(`${bill.id}\u0000${tx.id}`)) continue;
      if (!sameCurrency(bill.currency, tx.currency)) continue;
      if (txFree > 0 !== wantsIncoming) continue;
      if (
        tx.reference === null ||
        normalizeReference(tx.reference) !== billRef
      ) {
        continue;
      }
      const abs = Math.abs(txFree);
      const amount = remaining === null ? abs : Math.min(remaining, abs);
      // A matching reference paid to a different account is only a suggestion.
      const ibanConflict =
        bill.creditorIban !== null &&
        tx.counterpartyIban !== null &&
        normalizeIban(bill.creditorIban) !== "" &&
        normalizeIban(tx.counterpartyIban) !== "" &&
        normalizeIban(bill.creditorIban) !== normalizeIban(tx.counterpartyIban);
      rule1.push({
        billId: bill.id,
        transactionId: tx.id,
        rule: "reference",
        confidence: ibanConflict ? "high" : "exact",
        amount: minor(amount),
        ambiguous: ibanConflict,
      });
      consumed.set(tx.id, Math.max(consumed.get(tx.id) ?? 0, amount));
    }
  }

  // Pass 2: creditor IBAN + amount, evaluated against what a reference match leaves over.
  for (const { bill, settled, remaining, overpaid, wantsIncoming } of open) {
    const billIban =
      bill.creditorIban !== null ? normalizeIban(bill.creditorIban) : "";
    if (billIban === "" || bill.amount === null) continue;
    const window = paymentWindow(bill, o);
    for (const { tx, free: txFree } of free) {
      if (allocated.has(`${bill.id}\u0000${tx.id}`)) continue;
      if (!sameCurrency(bill.currency, tx.currency)) continue;
      if (txFree > 0 !== wantsIncoming) continue;
      if (
        tx.counterpartyIban === null ||
        normalizeIban(tx.counterpartyIban) !== billIban
      ) {
        continue;
      }
      const abs = Math.abs(txFree) - (consumed.get(tx.id) ?? 0);
      if (abs <= 0) continue;

      if (overpaid) {
        // Refund of an overpayment: no date window, the exact surplus is specific enough.
        if (abs !== settled - bill.amount) continue;
      } else {
        if (abs !== remaining || window === null) continue;
        if (tx.bookingDate < window.from || tx.bookingDate > window.to)
          continue;
      }
      rule2.push({
        billId: bill.id,
        transactionId: tx.id,
        rule: "iban_amount",
        confidence: "high",
        amount: minor(overpaid ? 0 - abs : abs),
        ambiguous: false,
      });
    }
  }

  markAmbiguous(rule1);
  markAmbiguous(rule2);

  // A bill suggested by both rules needs the user's decision. The reference
  // suggestions stay unambiguous only if both together fit into the remaining amount.
  const rule1Bills = new Set(rule1.map((s) => s.billId));
  const rule2Bills = new Set(rule2.map((s) => s.billId));
  const totals = new Map<string, number>();
  for (const s of [...rule1, ...rule2]) {
    totals.set(s.billId, (totals.get(s.billId) ?? 0) + Math.abs(s.amount));
  }
  const remainingById = new Map(open.map((x) => [x.bill.id, x.remaining]));
  for (const s of rule2) {
    if (rule1Bills.has(s.billId)) s.ambiguous = true;
  }
  for (const s of rule1) {
    if (
      rule2Bills.has(s.billId) &&
      (totals.get(s.billId) ?? 0) > (remainingById.get(s.billId) ?? 0)
    ) {
      s.ambiguous = true;
    }
  }
  const rule2Kept = rule2;

  const billById = new Map(bills.map((b) => [b.id, b]));
  const txById = new Map(transactions.map((t) => [t.id, t]));
  return [...rule1, ...rule2Kept].sort((a, b) => {
    const dueA = (billById.get(a.billId) as MatchBill).dueDate;
    const dueB = (billById.get(b.billId) as MatchBill).dueDate;
    if (dueA !== dueB) {
      if (dueA === null) return 1;
      if (dueB === null) return -1;
      return cmp(dueA, dueB);
    }
    return (
      cmp(a.billId, b.billId) ||
      cmp(
        (txById.get(a.transactionId) as MatchTransaction).bookingDate,
        (txById.get(b.transactionId) as MatchTransaction).bookingDate,
      ) ||
      cmp(a.transactionId, b.transactionId)
    );
  });
}

export function autoConfirmable(s: Suggestion): boolean {
  return s.rule === "reference" && !s.ambiguous;
}
