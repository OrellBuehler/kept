import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { BillKind } from "$lib/bill-types";
import { type Minor } from "$lib/money";
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
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import {
  allocateInTx,
  type AllocationTx,
  loadAllocations,
  toMatchTransaction,
} from "./allocations";
import {
  billsLock,
  getBill,
  getBillInTx,
  listBills,
  listBillsInTx,
  toMatchBill,
} from "./bills";
import { transactionDisplayColumns, type TransactionDisplay } from "./display";
import {
  autoConfirmable,
  computeBillStatus,
  suggestMatches,
  type Allocation,
  type MatchBill,
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

/** Only bills that can still take a payment or refund bound the transaction window. */
function windowFor(
  matchBills: readonly MatchBill[],
  allocations: readonly Allocation[],
): { anyOpen: boolean; since: string | undefined } {
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
  return {
    anyOpen,
    since:
      unbounded || lowerBound === null
        ? undefined
        : subtractDays(lowerBound, WINDOW_LEAD_DAYS),
  };
}

function windowQuery(
  db: Pick<DB, "select">,
  userId: string,
  since: string | undefined,
) {
  return db
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
    .limit(MAX_SUGGESTION_TRANSACTIONS);
}

async function compute(userId: string, onlyBillId?: string): Promise<Computed> {
  const db = getDB();
  const allBills = (await listBills(userId)).filter((b) => !b.cancelled);
  const allocations = await loadAllocations(userId);
  const matchBills = allBills.map(toMatchBill);

  const { anyOpen, since } = windowFor(matchBills, allocations);
  if (!anyOpen) return { suggestions: [], truncated: false };
  const txRows = await windowQuery(db, userId, since);
  const truncated = txRows.length >= MAX_SUGGESTION_TRANSACTIONS;
  if (truncated) console.warn("suggestion window truncated");

  // Dismissed pairs take part in the engine run, so ambiguity they cause stays
  // visible (and blocks auto-confirmation); they are only hidden from the result.
  const dismissed = new Set(
    (
      await db
        .select({
          billId: matchDismissals.billId,
          transactionId: matchDismissals.transactionId,
        })
        .from(matchDismissals)
        .where(eq(matchDismissals.userId, userId))
    ).map((d) => pairKey(d.billId, d.transactionId)),
  );

  const found = suggestMatches(
    matchBills,
    txRows.map(toMatchTransaction),
    allocations,
  ).filter(
    (s) =>
      (onlyBillId === undefined || s.billId === onlyBillId) &&
      !dismissed.has(pairKey(s.billId, s.transactionId)),
  );
  if (found.length === 0) return { suggestions: [], truncated };

  const remainingByBill = new Map(
    matchBills.map((b) => [b.id, computeBillStatus(b, allocations).remaining]),
  );
  const billById = new Map(allBills.map((b) => [b.id, b]));
  const txIds = new Set(found.map((s) => s.transactionId));
  const display = new Map(
    (
      await db
        .select(transactionDisplayColumns)
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.id, [...txIds]),
          ),
        )
    ).map((t) => [t.id, t]),
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
export async function getSuggestions(
  userId: string,
  options: { billId?: string } = {},
): Promise<SuggestionView[]> {
  return (await compute(userId, options.billId)).suggestions;
}

/**
 * What automatic matching would do and what is left to decide, without writing
 * anything. Use this where a page is merely viewed; `runAutoMatching` writes.
 */
export async function previewMatching(userId: string): Promise<{
  suggestions: SuggestionView[];
  truncated: boolean;
  autoPending: number;
}> {
  const { suggestions, truncated } = await compute(userId);
  return {
    suggestions,
    truncated,
    autoPending: suggestions.filter((s) => s.auto).length,
  };
}

/**
 * Pairs that automatic matching would confirm on the current state, read inside
 * the transaction: same rule as `compute`, minus dismissed pairs. Keyed by pair.
 */
async function freshAutoPlanInTx(
  tx: AllocationTx,
  userId: string,
): Promise<Map<string, Minor>> {
  const plan = new Map<string, Minor>();
  const matchBills = (await listBillsInTx(tx, userId))
    .filter((b) => !b.cancelled)
    .map(toMatchBill);
  const allocations = await tx
    .select({
      billId: billAllocations.billId,
      transactionId: billAllocations.transactionId,
      amount: billAllocations.amount,
    })
    .from(billAllocations)
    .where(eq(billAllocations.userId, userId));
  const { anyOpen, since } = windowFor(matchBills, allocations);
  if (!anyOpen) return plan;
  const txRows = await windowQuery(tx, userId, since);
  const dismissed = new Set(
    (
      await tx
        .select({
          billId: matchDismissals.billId,
          transactionId: matchDismissals.transactionId,
        })
        .from(matchDismissals)
        .where(eq(matchDismissals.userId, userId))
    ).map((d) => pairKey(d.billId, d.transactionId)),
  );
  const remainingByBill = new Map(
    matchBills.map((b) => [b.id, computeBillStatus(b, allocations).remaining]),
  );
  for (const s of suggestMatches(
    matchBills,
    txRows.map(toMatchTransaction),
    allocations,
  )) {
    const key = pairKey(s.billId, s.transactionId);
    if (
      !dismissed.has(key) &&
      isAuto(s, remainingByBill.get(s.billId) ?? null)
    ) {
      plan.set(key, s.amount);
    }
  }
  return plan;
}

/**
 * Writes the planned automatic allocations in one transaction. The plan was
 * computed across awaits, so every pair is re-checked on fresh state first: a
 * pair that was dismissed, became ambiguous or is no longer an exact match is
 * skipped (a dismissal is kept, never deleted). Returns the bills that changed.
 */
export async function writeAutoMatches(
  userId: string,
  planned: ReadonlyArray<{ billId: string; transactionId: string }>,
): Promise<string[]> {
  return await transaction(async (tx) => {
    const fresh = await freshAutoPlanInTx(tx, userId);
    const billIds: string[] = [];
    for (const s of planned) {
      const amount = fresh.get(pairKey(s.billId, s.transactionId));
      if (amount === undefined) {
        console.warn("auto-match skipped", "stale");
        continue;
      }
      // Each allocation also re-validates against the allocations of its
      // transaction, so a payment taken meanwhile is skipped, not double-booked.
      try {
        await allocateInTx(
          tx,
          userId,
          s.billId,
          s.transactionId,
          amount,
          "auto",
        );
        billIds.push(s.billId);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        console.warn("auto-match skipped", err.code);
      }
    }
    return billIds;
  }, billsLock(userId));
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
export async function runAutoMatching(
  userId: string,
): Promise<AutoMatchResult> {
  const initial = await compute(userId);
  const todo = initial.suggestions.filter((s) => s.auto);
  if (todo.length === 0) {
    return {
      matched: 0,
      suggestions: initial.suggestions,
      truncated: initial.truncated,
    };
  }
  const allocatedBills = await writeAutoMatches(userId, todo);
  // Announced after the commit, so listeners see the allocations.
  for (const billId of allocatedBills)
    afterCommit(() => emitBillChanged(userId, billId));
  const after = await compute(userId);
  return {
    matched: allocatedBills.length,
    suggestions: after.suggestions,
    truncated: after.truncated,
  };
}

/**
 * Removes an allocation. The pair is dismissed only if automatic matching would
 * otherwise put it straight back.
 */
export async function removeAllocation(
  userId: string,
  allocationId: string,
): Promise<void> {
  // Delete, check and dismissal must not interleave with an automatic run, or it
  // re-creates the allocation in between. Same lock as every allocation write.
  await transaction(async (tx) => {
    const [removed] = await tx
      .delete(billAllocations)
      .where(
        and(
          eq(billAllocations.userId, userId),
          eq(billAllocations.id, allocationId),
        ),
      )
      .returning({
        billId: billAllocations.billId,
        transactionId: billAllocations.transactionId,
      });
    if (!removed) throw notFound("Allocation");
    const plan = await freshAutoPlanInTx(tx, userId);
    if (plan.has(pairKey(removed.billId, removed.transactionId))) {
      await tx
        .insert(matchDismissals)
        .values({
          userId,
          billId: removed.billId,
          transactionId: removed.transactionId,
        })
        .onConflictDoNothing();
    }
    afterCommit(() => emitBillChanged(userId, removed.billId));
  }, billsLock(userId));
}

/** Brings a dismissed pair back as a suggestion. Idempotent. */
export async function undismissSuggestion(
  userId: string,
  billId: string,
  transactionId: string,
): Promise<void> {
  await getBill(userId, billId);
  await getDB()
    .delete(matchDismissals)
    .where(
      and(
        eq(matchDismissals.userId, userId),
        eq(matchDismissals.billId, billId),
        eq(matchDismissals.transactionId, transactionId),
      ),
    );
}

/** Transactions the user dismissed for this bill, newest first. */
export async function listDismissed(
  userId: string,
  billId: string,
): Promise<TransactionDisplay[]> {
  await getBill(userId, billId);
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
    .orderBy(desc(transactions.bookingDate), desc(transactions.id));
}

/** The bill and transaction ownership checks and the insert share one transaction. */
export async function dismissSuggestion(
  userId: string,
  billId: string,
  transactionId: string,
): Promise<void> {
  await transaction(async (tx) => {
    await getBillInTx(tx, userId, billId);
    const found = await first(
      tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, transactionId),
          ),
        )
        .limit(1),
    );
    if (!found) throw notFound("Transaction");
    await tx
      .insert(matchDismissals)
      .values({ userId, billId, transactionId })
      .onConflictDoNothing();
  });
}
