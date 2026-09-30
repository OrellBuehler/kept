import { and, eq, lte } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  transactions,
} from "$lib/server/db";
import { LedgerError, notFound } from "./errors";

/**
 * Balance model
 * -------------
 * - A snapshot is an END-OF-DAY balance: transactions booked on the snapshot
 *   date are already contained in it.
 * - The balance on date D, when a snapshot with date <= D exists, is the latest
 *   such snapshot plus the sum of transactions with snapshotDate < bookingDate <= D.
 * - Without such a snapshot it is openingBalance plus the sum of transactions
 *   with openingDate <= bookingDate <= D (no lower bound when openingDate is
 *   null). The opening balance is a START-OF-DAY value on openingDate. For D
 *   before openingDate no transactions count and the opening balance is returned.
 * - If a manual and an imported snapshot share a date, the manual one wins.
 * - Amounts are in the account's currency; there is no FX conversion.
 */

export interface BalanceInput {
  openingBalance: number;
  openingDate: string | null;
  snapshots: readonly { date: string; amount: number; source?: string }[];
  transactions: readonly { bookingDate: string; amount: number }[];
}

export type BalanceAt = (date: string) => Minor;

/** First index whose value is > target (i.e. count of values <= target). */
function upperBound(sorted: readonly string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is >= target (i.e. count of values < target). */
function lowerBound(sorted: readonly string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Builds a balance lookup from prefix sums: O(n log n) once, O(log n) per date.
 */
export function makeBalanceAt(input: BalanceInput): BalanceAt {
  const txs = [...input.transactions].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
  );
  const dates = txs.map((t) => t.bookingDate);
  const cumulative: number[] = [0];
  for (const t of txs)
    cumulative.push(cumulative[cumulative.length - 1]! + t.amount);

  const byDate = new Map<string, { amount: number; source?: string }>();
  for (const s of input.snapshots) {
    const existing = byDate.get(s.date);
    if (!existing || (s.source === "manual" && existing.source !== "manual")) {
      byDate.set(s.date, s);
    }
  }
  const snapshots = [...byDate.entries()]
    .map(([date, s]) => ({ date, amount: s.amount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const snapshotDates = snapshots.map((s) => s.date);

  const sumBetween = (from: number, to: number) =>
    cumulative[to]! - cumulative[from]!;

  return (date) => {
    const upto = upperBound(dates, date);
    const snapIdx = upperBound(snapshotDates, date) - 1;
    if (snapIdx >= 0) {
      const snap = snapshots[snapIdx]!;
      const after = upperBound(dates, snap.date);
      return minor(snap.amount + sumBetween(after, Math.max(after, upto)));
    }
    if (input.openingDate !== null && date < input.openingDate) {
      return minor(input.openingBalance);
    }
    const start =
      input.openingDate === null ? 0 : lowerBound(dates, input.openingDate);
    return minor(
      input.openingBalance + sumBetween(start, Math.max(start, upto)),
    );
  };
}

export function balanceAt(input: BalanceInput, date: string): Minor {
  return makeBalanceAt(input)(date);
}

export type SeriesStep = "day" | "month";
export interface BalancePoint {
  date: string;
  amount: Minor;
}

export const MAX_SERIES_POINTS = 3700;

function toUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Dates for a chart: every day in [from, to], or the last day of each month
 * from the month of `from` up to `to` (the final point is clamped to `to`).
 */
export function seriesDates(
  from: string,
  to: string,
  step: SeriesStep,
): string[] {
  if (from > to) return [];
  const out: string[] = [];
  const end = toUtc(to);
  if (step === "day") {
    for (let d = toUtc(from); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(iso(d));
      if (out.length > MAX_SERIES_POINTS) break;
    }
  } else {
    const start = toUtc(from);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    for (;;) {
      const monthEnd = iso(new Date(Date.UTC(y, m + 1, 0)));
      if (monthEnd >= to) {
        out.push(to);
        break;
      }
      out.push(monthEnd);
      if (out.length > MAX_SERIES_POINTS) break;
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }
  if (out.length > MAX_SERIES_POINTS) {
    throw new LedgerError(
      "invalid",
      "The requested range has too many points.",
    );
  }
  return out;
}

export function balanceSeriesOf(
  input: BalanceInput,
  from: string,
  to: string,
  step: SeriesStep,
): BalancePoint[] {
  const at = makeBalanceAt(input);
  return seriesDates(from, to, step).map((date) => ({
    date,
    amount: at(date),
  }));
}

// --- database wrappers ----------------------------------------------------

function loadInput(
  userId: string,
  accountId: string,
  upTo: string | null,
): BalanceInput {
  const db = getDB();
  const account = db
    .select({
      openingBalance: accounts.openingBalance,
      openingDate: accounts.openingDate,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!account) throw notFound("Account");

  const txWhere = [
    eq(transactions.userId, userId),
    eq(transactions.accountId, accountId),
  ];
  const snapWhere = [
    eq(balanceSnapshots.userId, userId),
    eq(balanceSnapshots.accountId, accountId),
  ];
  if (upTo !== null) {
    txWhere.push(lte(transactions.bookingDate, upTo));
    snapWhere.push(lte(balanceSnapshots.date, upTo));
  }
  return {
    openingBalance: account.openingBalance,
    openingDate: account.openingDate,
    transactions: db
      .select({
        bookingDate: transactions.bookingDate,
        amount: transactions.amount,
      })
      .from(transactions)
      .where(and(...txWhere))
      .all(),
    snapshots: db
      .select({
        date: balanceSnapshots.date,
        amount: balanceSnapshots.amount,
        source: balanceSnapshots.source,
      })
      .from(balanceSnapshots)
      .where(and(...snapWhere))
      .all(),
  };
}

/** Balance at the end of `date` (see the model above). */
export function accountBalanceAt(
  userId: string,
  accountId: string,
  date: string,
): Minor {
  return balanceAt(loadInput(userId, accountId, date), date);
}

export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Balance as of `today` (YYYY-MM-DD, default local today): future-dated
 * transactions and snapshots do not count.
 */
export function currentBalance(
  userId: string,
  accountId: string,
  today: string = localToday(),
): Minor {
  return balanceAt(loadInput(userId, accountId, today), today);
}

/** Current balances of several accounts with two queries in total. */
export function currentBalances(
  userId: string,
  accountRows: readonly {
    id: string;
    openingBalance: number;
    openingDate: string | null;
  }[],
  today: string = localToday(),
): Map<string, Minor> {
  const db = getDB();
  const txByAccount = new Map<string, BalanceInput["transactions"][number][]>();
  for (const t of db
    .select({
      accountId: transactions.accountId,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        lte(transactions.bookingDate, today),
      ),
    )
    .all()) {
    const list = txByAccount.get(t.accountId) ?? [];
    list.push(t);
    txByAccount.set(t.accountId, list);
  }
  const snapByAccount = new Map<string, BalanceInput["snapshots"][number][]>();
  for (const s of db
    .select({
      accountId: balanceSnapshots.accountId,
      date: balanceSnapshots.date,
      amount: balanceSnapshots.amount,
      source: balanceSnapshots.source,
    })
    .from(balanceSnapshots)
    .where(
      and(
        eq(balanceSnapshots.userId, userId),
        lte(balanceSnapshots.date, today),
      ),
    )
    .all()) {
    const list = snapByAccount.get(s.accountId) ?? [];
    list.push(s);
    snapByAccount.set(s.accountId, list);
  }
  return new Map(
    accountRows.map((a) => [
      a.id,
      balanceAt(
        {
          openingBalance: a.openingBalance,
          openingDate: a.openingDate,
          transactions: txByAccount.get(a.id) ?? [],
          snapshots: snapByAccount.get(a.id) ?? [],
        },
        today,
      ),
    ]),
  );
}

export function balanceSeries(
  userId: string,
  accountId: string,
  from: string,
  to: string,
  step: SeriesStep,
): BalancePoint[] {
  return balanceSeriesOf(loadInput(userId, accountId, to), from, to, step);
}
