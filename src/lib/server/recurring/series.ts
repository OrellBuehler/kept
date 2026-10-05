import { and, eq, inArray, ne } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import type { Cadence, SeriesStatus } from "$lib/recurring-types";
import { type DB, getDB, recurringSeries, transactions } from "$lib/server/db";
import { addDays } from "$lib/server/dashboard/dates";
import { localToday } from "$lib/server/ledger/balances";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { isRealDate } from "$lib/server/ledger/schemas";
import {
  annualCost,
  detectSeries,
  expectedDates,
  monthlyCost,
  occurrenceAfter,
  priceChange,
  type DetectInput,
  type PriceChange,
} from "./detect";
import { parseEditedAmount, type SeriesEditInput } from "./schemas";

export interface RecurringView {
  id: string;
  status: SeriesStatus;
  name: string;
  counterpartyIban: string | null;
  cadence: Cadence;
  currency: string;
  /** Typical amount per occurrence, signed: negative for payments, positive for income. */
  amount: Minor;
  /** Cost per year, signed like `amount`. */
  annualCost: Minor;
  /** Cost per month (annual / 12, rounded), signed like `amount`. */
  monthlyCost: Minor;
  firstDate: string;
  lastDate: string;
  lastAmount: Minor;
  occurrences: number;
  nextExpected: string;
  /** The next payment is more than a week late. */
  overdue: boolean;
  /** Set when the latest amount differs from the previous one by more than 1%. */
  priceChange: PriceChange | null;
}

export interface RecurringTotals {
  currency: string;
  /** Confirmed payments, as positive numbers. */
  outflowMonthly: Minor;
  outflowAnnual: Minor;
  /** Confirmed income, as positive numbers. */
  inflowMonthly: Minor;
  inflowAnnual: Minor;
}

export interface ProjectedOccurrence {
  seriesId: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  /** Signed: negative for payments, positive for income. */
  amount: Minor;
  currency: string;
  cadence: Cadence;
}

type Row = typeof recurringSeries.$inferSelect;

const OVERDUE_GRACE_DAYS = 7;

function toView(row: Row, today: string): RecurringView {
  const nextExpected = occurrenceAfter(row.lastDate, row.cadence, 1);
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    counterpartyIban: row.counterpartyIban,
    cadence: row.cadence,
    currency: row.currency,
    amount: row.amount,
    annualCost: annualCost(row.amount, row.cadence),
    monthlyCost: monthlyCost(row.amount, row.cadence),
    firstDate: row.firstDate,
    lastDate: row.lastDate,
    lastAmount: row.lastAmount,
    occurrences: row.occurrences,
    nextExpected,
    overdue: addDays(nextExpected, OVERDUE_GRACE_DAYS) < today,
    priceChange: priceChange(row.lastAmount, row.previousAmount),
  };
}

type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;

/** Sync: runs inside the transaction of syncRecurring. */
function loadTransactionsInTx(tx: Tx, userId: string): DetectInput[] {
  return tx
    .select({
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      currency: transactions.currency,
      counterpartyName: transactions.counterpartyName,
      counterpartyIban: transactions.counterpartyIban,
      description: transactions.description,
      reversal: transactions.reversal,
    })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), ne(transactions.source, "mirror")),
    )
    .all();
}

/**
 * Re-runs detection over the user's transactions and stores the result. The
 * transactions, the stored series and the writes share one transaction, so two
 * overlapping runs cannot both insert a series or overwrite newer statistics
 * with older ones. New
 * series start as "suggested"; the status of known ones (confirmed or
 * dismissed) and any hand-edited name, cadence or amount are kept, only their
 * statistics (dates, last amount) are refreshed. Suggestions that no longer
 * hold are removed.
 */
export async function syncRecurring(userId: string): Promise<void> {
  getDB().transaction((tx) => {
    const detected = detectSeries(loadTransactionsInTx(tx, userId));
    const existing = new Map(
      tx
        .select()
        .from(recurringSeries)
        .where(eq(recurringSeries.userId, userId))
        .all()
        .map((r) => [r.key, r]),
    );
    for (const d of detected) {
      const stats = {
        counterpartyIban: d.counterpartyIban,
        firstDate: d.firstDate,
        lastDate: d.lastDate,
        lastAmount: d.lastAmount,
        previousAmount: d.previousAmount,
        occurrences: d.occurrences,
      };
      const row = existing.get(d.key);
      existing.delete(d.key);
      if (!row) {
        tx.insert(recurringSeries)
          .values({
            userId,
            key: d.key,
            name: d.name,
            cadence: d.cadence,
            currency: d.currency,
            amount: d.amount,
            ...stats,
          })
          .run();
      } else {
        tx.update(recurringSeries)
          .set(
            row.edited
              ? stats
              : {
                  ...stats,
                  name: d.name,
                  cadence: d.cadence,
                  amount: d.amount,
                },
          )
          .where(
            and(
              eq(recurringSeries.userId, userId),
              eq(recurringSeries.id, row.id),
            ),
          )
          .run();
      }
    }
    const stale = [...existing.values()]
      .filter((r) => r.status === "suggested" && !r.edited)
      .map((r) => r.id);
    if (stale.length > 0) {
      tx.delete(recurringSeries)
        .where(
          and(
            eq(recurringSeries.userId, userId),
            inArray(recurringSeries.id, stale),
          ),
        )
        .run();
    }
  });
}

/** Stored series for the user, newest payment first. Does not run detection. */
export async function listRecurring(
  userId: string,
  today: string = localToday(),
): Promise<RecurringView[]> {
  return (
    await getDB()
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, userId))
  )
    .map((r) => toView(r, today))
    .sort(
      (a, b) =>
        a.nextExpected.localeCompare(b.nextExpected) ||
        a.name.localeCompare(b.name),
    );
}

/** Monthly and annual totals of confirmed series, one entry per currency (no conversion). */
export function recurringTotals(series: RecurringView[]): RecurringTotals[] {
  const by = new Map<string, RecurringTotals>();
  for (const s of series) {
    if (s.status !== "confirmed") continue;
    const t = by.get(s.currency) ?? {
      currency: s.currency,
      outflowMonthly: minor(0),
      outflowAnnual: minor(0),
      inflowMonthly: minor(0),
      inflowAnnual: minor(0),
    };
    if (s.amount < 0) {
      t.outflowMonthly = minor(t.outflowMonthly - s.monthlyCost);
      t.outflowAnnual = minor(t.outflowAnnual - s.annualCost);
    } else {
      t.inflowMonthly = minor(t.inflowMonthly + s.monthlyCost);
      t.inflowAnnual = minor(t.inflowAnnual + s.annualCost);
    }
    by.set(s.currency, t);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

async function setStatus(userId: string, id: string, status: SeriesStatus) {
  const updated = await getDB()
    .update(recurringSeries)
    .set({ status })
    .where(and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)))
    .returning({ id: recurringSeries.id });
  if (updated.length === 0) throw notFound("Recurring payment");
}

export const confirmSeries = (userId: string, id: string) =>
  setStatus(userId, id, "confirmed");

/** Dismissed series stay stored, so detection never suggests them again. */
export const dismissSeries = (userId: string, id: string) =>
  setStatus(userId, id, "dismissed");

/** Moves a dismissed or confirmed series back to "suggested". */
export const restoreSeries = (userId: string, id: string) =>
  setStatus(userId, id, "suggested");

/** The series is read in the transaction that edits it, so the sign and currency used are current. */
export async function editSeries(
  userId: string,
  id: string,
  input: SeriesEditInput,
): Promise<void> {
  getDB().transaction((tx) => {
    const row = tx
      .select()
      .from(recurringSeries)
      .where(
        and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)),
      )
      .limit(1)
      .get();
    if (!row) throw notFound("Recurring payment");
    const parsed = parseEditedAmount(input.amount, row.currency);
    if (!parsed.ok) throw new LedgerError("invalid", parsed.message, "amount");
    tx.update(recurringSeries)
      .set({
        name: input.name,
        cadence: input.cadence,
        amount: minor(row.amount < 0 ? -parsed.value : parsed.value),
        edited: true,
      })
      .where(
        and(eq(recurringSeries.userId, userId), eq(recurringSeries.id, id)),
      )
      .run();
  });
}

/**
 * Expected occurrences of the user's confirmed series with a date in
 * [from, to] (inclusive, YYYY-MM-DD), sorted by date, then name.
 *
 * - Refreshes detection first, so the last seen payment is current.
 * - Only occurrences after a series' last payment are returned; payments
 *   already booked are not repeated.
 * - Amounts are signed (payments negative, income positive) in the series'
 *   currency; nothing is converted between currencies.
 * - Suggested and dismissed series are never projected.
 * - A series is projected until the user dismisses it, even when a payment
 *   is overdue.
 */
export async function projectRecurring(
  userId: string,
  from: string,
  to: string,
): Promise<ProjectedOccurrence[]> {
  if (!isRealDate(from) || !isRealDate(to)) {
    throw new LedgerError("invalid", "Enter dates as YYYY-MM-DD.");
  }
  if (from > to) return [];
  await syncRecurring(userId);
  const rows = await getDB()
    .select()
    .from(recurringSeries)
    .where(
      and(
        eq(recurringSeries.userId, userId),
        eq(recurringSeries.status, "confirmed"),
      ),
    );
  return rows
    .flatMap((r) =>
      expectedDates(r.lastDate, r.cadence, from, to).map((date) => ({
        seriesId: r.id,
        name: r.name,
        date,
        amount: r.amount,
        currency: r.currency,
        cadence: r.cadence,
      })),
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.name.localeCompare(b.name) ||
        a.seriesId.localeCompare(b.seriesId),
    );
}
