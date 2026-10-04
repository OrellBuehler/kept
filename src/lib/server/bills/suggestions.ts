import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { BillKind } from "$lib/bill-types";
import { type Minor } from "$lib/money";
import {
  accounts,
  billAllocations,
  getDB,
  matchDismissals,
  transactions,
} from "$lib/server/db";
import { emitBillChanged } from "$lib/server/events";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { allocate, loadAllocations, toMatchTransaction } from "./allocations";
import { getBill, listBills, toMatchBill } from "./bills";
import { transactionDisplayColumns, type TransactionDisplay } from "./display";
import {
  autoConfirmable,
  computeBillStatus,
  suggestMatches,
  type Suggestion,
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
  /** The transaction window hit its row cap, so older payments were not considered. */
  truncated: boolean;
}

const pairKey = (billId: string, transactionId: string) =>
  `${billId}|${transactionId}`;

/**
 * Automatic confirmation needs an exact, unambiguous reference match that covers
 * the bill's remaining amount exactly (or an open-amount bill). Partial payments
 * stay suggestions, in case a creditor reuses a reference.
 */
function isAuto(s: Suggestion, remaining: Minor | null): boolean {
  return autoConfirmable(s) && (remaining === null || s.amount === remaining);
}

function compute(
  userId: string,
  onlyBillId?: string,
  includeDismissed = false,
): Computed {
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
  if (!anyOpen) return { suggestions: [], truncated: false };

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
        // A mirror is the counter-side of a transfer between own accounts, never a payment.
        ne(transactions.source, "mirror"),
        since ? gte(transactions.bookingDate, since) : undefined,
      ),
    )
    .orderBy(desc(transactions.bookingDate), desc(transactions.id))
    .limit(MAX_SUGGESTION_TRANSACTIONS)
    .all();
  const truncated = txRows.length >= MAX_SUGGESTION_TRANSACTIONS;
  if (truncated) console.warn("suggestion window truncated");

  // Dismissed pairs take part in the engine run, so ambiguity they cause stays
  // visible (and blocks auto-confirmation); they are only hidden from the result.
  const dismissed = new Set(
    db
      .select({
        billId: matchDismissals.billId,
        transactionId: matchDismissals.transactionId,
      })
      .from(matchDismissals)
      .where(eq(matchDismissals.userId, userId))
      .all()
      .map((d) => pairKey(d.billId, d.transactionId)),
  );

  const found = suggestMatches(
    matchBills,
    txRows.map(toMatchTransaction),
    allocations,
  ).filter(
    (s) =>
      (onlyBillId === undefined || s.billId === onlyBillId) &&
      (includeDismissed || !dismissed.has(pairKey(s.billId, s.transactionId))),
  );
  if (found.length === 0) return { suggestions: [], truncated };

  const remainingByBill = new Map(
    matchBills.map((b) => [b.id, computeBillStatus(b, allocations).remaining]),
  );
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
    truncated,
    suggestions: found.map((s) => {
      const bill = billById.get(s.billId)!;
      return {
        billId: s.billId,
        transactionId: s.transactionId,
        rule: s.rule,
        confidence: s.confidence,
        amount: s.amount,
        ambiguous: s.ambiguous,
        auto: isAuto(s, remainingByBill.get(s.billId) ?? null),
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
 * What automatic matching would do and what is left to decide, without writing
 * anything. Use this where a page is merely viewed; `runAutoMatching` writes.
 */
export function previewMatching(userId: string): {
  suggestions: SuggestionView[];
  truncated: boolean;
  autoPending: number;
} {
  const { suggestions, truncated } = compute(userId);
  return {
    suggestions,
    truncated,
    autoPending: suggestions.filter((s) => s.auto).length,
  };
}

/** Whether the pair would be confirmed automatically if it were not dismissed. */
export function wouldAutoConfirm(
  userId: string,
  billId: string,
  transactionId: string,
): boolean {
  return compute(userId, billId, true).suggestions.some(
    (s) => s.transactionId === transactionId && s.auto,
  );
}

export interface AutoMatchResult {
  /** Allocations created by this run. */
  matched: number;
  /** What is left to decide, after the automatic matches. */
  suggestions: SuggestionView[];
  truncated: boolean;
}

/**
 * Confirms every exact, unambiguous reference match that covers the bill's
 * remaining amount as an `auto` allocation. Idempotent: confirmed pairs are never
 * suggested again. Also returns the remaining suggestions, so callers match once.
 */
export function runAutoMatching(userId: string): AutoMatchResult {
  const first = compute(userId);
  const todo = first.suggestions.filter((s) => s.auto);
  if (todo.length === 0) {
    return {
      matched: 0,
      suggestions: first.suggestions,
      truncated: first.truncated,
    };
  }
  let matched = 0;
  getDB().transaction(() => {
    for (const s of todo) {
      try {
        allocate(userId, s.billId, s.transactionId, s.amount, "auto");
        matched++;
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        console.warn("auto-match skipped", err.code);
      }
    }
  });
  const after = compute(userId);
  return {
    matched,
    suggestions: after.suggestions,
    truncated: after.truncated,
  };
}

/**
 * Removes an allocation. The pair is dismissed only if automatic matching would
 * otherwise put it straight back.
 */
export function removeAllocation(userId: string, allocationId: string): void {
  const db = getDB();
  const row = db
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
    })
    .from(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        eq(billAllocations.id, allocationId),
      ),
    )
    .get();
  if (!row) throw notFound("Allocation");
  db.delete(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        eq(billAllocations.id, allocationId),
      ),
    )
    .run();
  if (wouldAutoConfirm(userId, row.billId, row.transactionId)) {
    db.insert(matchDismissals)
      .values({ userId, billId: row.billId, transactionId: row.transactionId })
      .onConflictDoNothing()
      .run();
  }
  emitBillChanged(userId, row.billId);
}

/** Brings a dismissed pair back as a suggestion. Idempotent. */
export function undismissSuggestion(
  userId: string,
  billId: string,
  transactionId: string,
): void {
  getBill(userId, billId);
  getDB()
    .delete(matchDismissals)
    .where(
      and(
        eq(matchDismissals.userId, userId),
        eq(matchDismissals.billId, billId),
        eq(matchDismissals.transactionId, transactionId),
      ),
    )
    .run();
}

/** Transactions the user dismissed for this bill, newest first. */
export function listDismissed(
  userId: string,
  billId: string,
): TransactionDisplay[] {
  getBill(userId, billId);
  return getDB()
    .select(transactionDisplayColumns)
    .from(matchDismissals)
    .innerJoin(transactions, eq(transactions.id, matchDismissals.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(matchDismissals.userId, userId),
        eq(transactions.userId, userId),
        eq(matchDismissals.billId, billId),
      ),
    )
    .orderBy(desc(transactions.bookingDate), desc(transactions.id))
    .all();
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
