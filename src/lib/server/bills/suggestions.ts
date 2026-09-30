import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { BillKind } from "$lib/bill-types";
import { minor, type Minor } from "$lib/money";
import { accounts, getDB, matchDismissals, transactions } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { allocate, loadAllocations, toMatchTransaction } from "./allocations";
import { getBill, listBills, toMatchBill } from "./bills";
import { transactionDisplayColumns, type TransactionDisplay } from "./display";
import {
  autoConfirmable,
  computeBillStatus,
  suggestMatches,
  type Allocation,
  type MatchRule,
} from "./matching";

export const MAX_SUGGESTION_TRANSACTIONS = 5000;
const WINDOW_LEAD_DAYS = 60;

export interface SuggestionView {
  billId: string;
  transactionId: string;
  rule: MatchRule;
  confidence: "exact" | "high";
  /** Signed in the bill's direction (negative for refunds of an overpayment). */
  amount: Minor;
  ambiguous: boolean;
  /** True when it may be confirmed without asking (exact reference, unambiguous). */
  auto: boolean;
  bill: {
    id: string;
    kind: BillKind;
    creditorName: string | null;
    invoiceNumber: string | null;
    amount: Minor | null;
    currency: string;
    dueDate: string | null;
  };
  transaction: TransactionDisplay;
}

function subtractDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - days)).toISOString().slice(0, 10);
}

interface Computed {
  suggestions: SuggestionView[];
}

function compute(userId: string, onlyBillId?: string): Computed {
  const db = getDB();
  const allBills = listBills(userId).filter((b) => !b.cancelled);
  const allocations = loadAllocations(userId);
  const matchBills = allBills.map(toMatchBill);

  // Only bills that can still take a payment or refund bound the transaction window.
  let lowerBound: string | null = null;
  let unbounded = false;
  let anyOpen = false;
  for (const b of matchBills) {
    const { status } = computeBillStatus(b, allocations);
    const wantsMore =
      status === "open" ||
      status === "partially_paid" ||
      status === "credit_due" ||
      (status === "overpaid" && b.kind === "invoice");
    if (!wantsMore) continue;
    anyOpen = true;
    const anchor = b.issueDate ?? b.dueDate;
    if (anchor === null) unbounded = true;
    else if (lowerBound === null || anchor < lowerBound) lowerBound = anchor;
  }
  if (!anyOpen) return { suggestions: [] };

  const since =
    unbounded || lowerBound === null
      ? undefined
      : subtractDays(lowerBound, WINDOW_LEAD_DAYS);
  const txRows = db
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      currency: transactions.currency,
      reference: transactions.reference,
      counterpartyIban: transactions.counterpartyIban,
      counterpartyName: transactions.counterpartyName,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        since ? gte(transactions.bookingDate, since) : undefined,
      ),
    )
    .orderBy(desc(transactions.bookingDate), desc(transactions.id))
    .limit(MAX_SUGGESTION_TRANSACTIONS)
    .all();

  // A dismissed pair acts like a zero-amount allocation: the engine skips pairs
  // that already have an allocation and the zero changes no sums.
  const dismissed: Allocation[] = db
    .select({
      billId: matchDismissals.billId,
      transactionId: matchDismissals.transactionId,
    })
    .from(matchDismissals)
    .where(eq(matchDismissals.userId, userId))
    .all()
    .map((d) => ({ ...d, amount: minor(0) }));

  const found = suggestMatches(matchBills, txRows.map(toMatchTransaction), [
    ...allocations,
    ...dismissed,
  ]).filter((s) => onlyBillId === undefined || s.billId === onlyBillId);
  if (found.length === 0) return { suggestions: [] };

  const billById = new Map(allBills.map((b) => [b.id, b]));
  const txIds = new Set(found.map((s) => s.transactionId));
  const display = new Map(
    db
      .select(transactionDisplayColumns)
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, [...txIds]),
        ),
      )
      .all()
      .map((t) => [t.id, t]),
  );
  return {
    suggestions: found.map((s) => {
      const bill = billById.get(s.billId)!;
      return {
        billId: s.billId,
        transactionId: s.transactionId,
        rule: s.rule,
        confidence: s.confidence,
        amount: s.amount,
        ambiguous: s.ambiguous,
        auto: autoConfirmable(s),
        bill: {
          id: bill.id,
          kind: bill.kind,
          creditorName: bill.creditorName,
          invoiceNumber: bill.invoiceNumber,
          amount: bill.amount,
          currency: bill.currency,
          dueDate: bill.dueDate,
        },
        transaction: display.get(s.transactionId)!,
      };
    }),
  };
}

/** Suggested bill/payment pairs, without the ones the user dismissed. Nothing is written. */
export function getSuggestions(
  userId: string,
  options: { billId?: string } = {},
): SuggestionView[] {
  return compute(userId, options.billId).suggestions;
}

/**
 * Confirms every exact, unambiguous reference match as an `auto` allocation.
 * Idempotent: confirmed pairs are never suggested again. Returns how many were created.
 */
export function runAutoMatching(userId: string): number {
  const todo = compute(userId).suggestions.filter((s) => s.auto);
  if (todo.length === 0) return 0;
  let created = 0;
  getDB().transaction(() => {
    for (const s of todo) {
      try {
        allocate(userId, s.billId, s.transactionId, s.amount, "auto");
        created++;
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        console.warn("auto-match skipped", err.code);
      }
    }
  });
  return created;
}

export function dismissSuggestion(
  userId: string,
  billId: string,
  transactionId: string,
): void {
  getBill(userId, billId);
  const tx = getDB()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, transactionId)),
    )
    .get();
  if (!tx) throw notFound("Transaction");
  getDB()
    .insert(matchDismissals)
    .values({ userId, billId, transactionId })
    .onConflictDoNothing()
    .run();
}
