import { and, eq, lte, min } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  transactions,
} from "$lib/server/db";
import { makeBalanceAt } from "$lib/server/ledger/balances";
import { addMonths, stepDates, type NetWorthStep } from "./dates";

export interface NetWorthPoint {
  date: string;
  amount: Minor;
}

export interface NetWorthCurrencySeries {
  currency: string;
  points: NetWorthPoint[];
}

export interface NetWorthOptions {
  /** Default: 12 months before `to`. */
  from?: string;
  /** Default: `today`. */
  to?: string;
  /** Default: "month". */
  step?: NetWorthStep;
  today: string;
}

interface Collected {
  currency: string;
  openingBalance: number;
  openingDate: string | null;
  transactions: { bookingDate: string; amount: number }[];
  snapshots: { date: string; amount: number; source: string }[];
}

/**
 * Sum of the balances of all non-archived accounts at each point, per
 * currency (no FX). Each account uses the same semantics as `balanceAt`
 * (snapshots + transactions, see ledger/balances.ts). Three queries in total.
 * Currencies are sorted alphabetically; every series has the same dates.
 */
export function netWorthSeries(
  userId: string,
  options: NetWorthOptions,
): NetWorthCurrencySeries[] {
  const to = options.to ?? options.today;
  const from = options.from ?? addMonths(to, -12);
  const dates = stepDates(from, to, options.step ?? "month");
  const db = getDB();

  const collected = new Map<string, Collected>();
  for (const a of db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      openingBalance: accounts.openingBalance,
      openingDate: accounts.openingDate,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.archived, false)))
    .all()) {
    collected.set(a.id, { ...a, transactions: [], snapshots: [] });
  }
  for (const t of db
    .select({
      accountId: transactions.accountId,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), lte(transactions.bookingDate, to)),
    )
    .all()) {
    collected.get(t.accountId)?.transactions.push(t);
  }
  for (const s of db
    .select({
      accountId: balanceSnapshots.accountId,
      date: balanceSnapshots.date,
      amount: balanceSnapshots.amount,
      source: balanceSnapshots.source,
    })
    .from(balanceSnapshots)
    .where(
      and(eq(balanceSnapshots.userId, userId), lte(balanceSnapshots.date, to)),
    )
    .all()) {
    collected.get(s.accountId)?.snapshots.push(s);
  }

  const sums = new Map<string, number[]>();
  for (const a of collected.values()) {
    const at = makeBalanceAt(a);
    let acc = sums.get(a.currency);
    if (!acc) {
      acc = dates.map(() => 0);
      sums.set(a.currency, acc);
    }
    const target = acc;
    dates.forEach((date, i) => {
      target[i]! += at(date);
    });
  }
  return [...sums.keys()].sort().map((currency) => ({
    currency,
    points: dates.map((date, i) => ({
      date,
      amount: minor(sums.get(currency)![i]!),
    })),
  }));
}

/** Earliest date with any data on a non-archived account, or null without data. */
export function earliestDataDate(userId: string): string | null {
  const db = getDB();
  const candidates = [
    db
      .select({ d: min(transactions.bookingDate) })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(eq(transactions.userId, userId), eq(accounts.archived, false)))
      .get()?.d,
    db
      .select({ d: min(balanceSnapshots.date) })
      .from(balanceSnapshots)
      .innerJoin(accounts, eq(accounts.id, balanceSnapshots.accountId))
      .where(
        and(eq(balanceSnapshots.userId, userId), eq(accounts.archived, false)),
      )
      .get()?.d,
    db
      .select({ d: min(accounts.openingDate) })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.archived, false)))
      .get()?.d,
  ].filter((d): d is string => typeof d === "string");
  return candidates.length ? candidates.sort()[0]! : null;
}
