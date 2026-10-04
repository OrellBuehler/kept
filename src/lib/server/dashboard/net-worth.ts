import { and, eq, isNotNull, lte, min, or } from "drizzle-orm";
import { minor, shareOf, type Minor, type ShareBasis } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  portfolios,
  portfolioValues,
  trades,
  transactions,
} from "$lib/server/db";
import { loadHoldingsInputs } from "$lib/server/investments/load";
import type { HoldingsInput } from "$lib/server/investments/valuation";
import { localToday, makeBalanceAt } from "$lib/server/ledger/balances";
import { loadPortfolioInputs } from "$lib/server/pillar3a/load";
import type { PortfoliosInput } from "$lib/server/pillar3a/valuation";
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
  /** "share" counts each account at its ownership share. Default: "total". */
  basis?: ShareBasis;
  today: string;
}

interface Collected {
  currency: string;
  shareBps: number;
  openingBalance: number;
  openingDate: string | null;
  /** First date on which the account no longer counts (it was archived that day). */
  archivedFrom: string | null;
  transactions: { bookingDate: string; amount: number }[];
  snapshots: { date: string; amount: number; source: string }[];
  holdings?: HoldingsInput;
  portfolios?: PortfoliosInput;
}

/**
 * Sum of the balances of all accounts at each point, per currency (no FX).
 * An archived account counts up to the day it was archived and 0 from then on. Each account uses the same semantics as `balanceAt`
 * (snapshots + transactions + holdings + portfolios, see ledger/balances.ts);
 * holdings are already converted into the account currency. A handful of queries in total.
 * Currencies are sorted alphabetically; every series has the same dates.
 * With basis "share" each account's balance is scaled by its ownership share
 * (rounded per account and date, see `shareOf`) before summing.
 */
export function netWorthSeries(
  userId: string,
  options: NetWorthOptions,
): NetWorthCurrencySeries[] {
  const to = options.to ?? options.today;
  const from = options.from ?? addMonths(to, -12);
  const dates = stepDates(from, to, options.step ?? "month");
  const basis = options.basis ?? "total";
  const db = getDB();

  const collected = new Map<string, Collected>();
  for (const a of db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      shareBps: accounts.shareBps,
      openingBalance: accounts.openingBalance,
      openingDate: accounts.openingDate,
      archived: accounts.archived,
      archivedAt: accounts.archivedAt,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all()) {
    const { archived, archivedAt, ...rest } = a;
    // An archived account without a timestamp has no known past: leave it out.
    if (archived && !archivedAt) continue;
    collected.set(a.id, {
      ...rest,
      archivedFrom: archivedAt ? localToday(archivedAt) : null,
      transactions: [],
      snapshots: [],
    });
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

  const holdings = loadHoldingsInputs(userId, [...collected.keys()], to);
  for (const [accountId, input] of holdings) {
    collected.get(accountId)!.holdings = input;
  }

  const portfolioInputs = loadPortfolioInputs(
    userId,
    [...collected.keys()],
    to,
  );
  for (const [accountId, input] of portfolioInputs) {
    collected.get(accountId)!.portfolios = input;
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
      const balance =
        a.archivedFrom !== null && date >= a.archivedFrom ? minor(0) : at(date);
      target[i]! += basis === "share" ? shareOf(balance, a.shareBps) : balance;
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

/**
 * Earliest date with any data on an account the series includes (not archived,
 * or archived with a known `archivedAt`), or null without data.
 */
export function earliestDataDate(userId: string): string | null {
  const db = getDB();
  const counted = or(
    eq(accounts.archived, false),
    isNotNull(accounts.archivedAt),
  );
  const candidates = [
    db
      .select({ d: min(transactions.bookingDate) })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(eq(transactions.userId, userId), counted))
      .get()?.d,
    db
      .select({ d: min(balanceSnapshots.date) })
      .from(balanceSnapshots)
      .innerJoin(accounts, eq(accounts.id, balanceSnapshots.accountId))
      .where(and(eq(balanceSnapshots.userId, userId), counted))
      .get()?.d,
    db
      .select({ d: min(trades.date) })
      .from(trades)
      .innerJoin(accounts, eq(accounts.id, trades.accountId))
      .where(and(eq(trades.userId, userId), counted))
      .get()?.d,
    db
      .select({ d: min(portfolioValues.date) })
      .from(portfolioValues)
      .innerJoin(portfolios, eq(portfolios.id, portfolioValues.portfolioId))
      .innerJoin(accounts, eq(accounts.id, portfolios.accountId))
      .where(and(eq(portfolioValues.userId, userId), counted))
      .get()?.d,
    db
      .select({ d: min(accounts.openingDate) })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), counted))
      .get()?.d,
  ].filter((d): d is string => typeof d === "string");
  return candidates.length ? candidates.sort()[0]! : null;
}
