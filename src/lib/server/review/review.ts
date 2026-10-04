import { and, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import type { CategoryKind } from "$lib/category-types";
import { minor, type Minor } from "$lib/money";
import {
  buildSankeyGraph,
  type SankeyGraph,
  type SankeyItem,
} from "$lib/sankey";
import { accounts, categories, getDB, transactions } from "$lib/server/db";
import { monthBounds } from "$lib/server/dashboard/dates";
import { netWorthSeries } from "$lib/server/dashboard/net-worth";
import { loadTransferExclusion } from "$lib/server/transfers/exclusion";

export const TOP_COUNTERPARTIES = 8;
export const TOP_TRANSACTIONS = 5;
export const TOP_CHANGES = 8;

/** A calendar year the review can cover: not in the future. */
export function yearSchema(today: string) {
  return z.coerce
    .number()
    .int()
    .min(1900)
    .max(Number(today.slice(0, 4)));
}

export type Side = "income" | "expense";

export interface CategoryChange {
  /** Null for uncategorized transactions. */
  categoryId: string | null;
  name: string;
  color: string | null;
  side: Side;
  amount: Minor;
  previous: Minor;
  change: Minor;
  /** change / previous; null when there was nothing to compare against. */
  changePct: number | null;
}

export interface CounterpartySpend {
  name: string;
  spent: Minor;
  count: number;
}

export interface LargeTransaction {
  id: string;
  bookingDate: string;
  /** Signed. */
  amount: Minor;
  counterparty: string | null;
  categoryName: string | null;
}

export interface MonthFlow {
  month: string;
  income: Minor;
  expenses: Minor;
}

export interface CurrencyReview {
  currency: string;
  income: Minor;
  expenses: Minor;
  net: Minor;
  /** net / income, null without income. */
  savingsRate: number | null;
  /** Balance on the last day of the previous year vs the end of the period; null without accounts. */
  netWorth: { start: Minor; end: Minor; change: Minor } | null;
  /** False when the previous year has no transactions in this currency. */
  hasPreviousYear: boolean;
  sankey: SankeyGraph;
  /** Biggest year-over-year movements by absolute change; empty without a previous year. */
  changes: CategoryChange[];
  counterparties: CounterpartySpend[];
  largestExpenses: LargeTransaction[];
  largestIncome: LargeTransaction[];
  months: MonthFlow[];
}

export interface YearReview {
  year: number;
  from: string;
  to: string;
  /** The year is not over yet. */
  partial: boolean;
  /** Transactions between the user's own accounts that were left out. */
  excludedTransfers: number;
  currencies: CurrencyReview[];
}

interface Cat {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  color: string | null;
}

interface Bucket {
  categoryId: string | null;
  name: string;
  color: string | null;
  side: Side;
  amount: number;
}

interface Row {
  id: string;
  accountId: string;
  bookingDate: string;
  amount: number;
  currency: string;
  reference: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  categoryId: string | null;
}

interface Classified {
  row: Row;
  currency: string;
  side: Side;
  /** Contribution to the side's total: a refund on an expense category is negative spending. */
  flow: number;
  bucketKey: string;
  top: Cat | null;
  own: Cat | null;
}

const UNCATEGORIZED = "Uncategorized";

function loadOwn(userId: string) {
  const own = getDB()
    .select({
      id: accounts.id,
      archived: accounts.archived,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all();
  const active = new Map(
    own.filter((a) => !a.archived).map((a) => [a.id, a.currency]),
  );
  return { active, exclusion: loadTransferExclusion(userId) };
}

function loadRows(userId: string, from: string, to: string): Row[] {
  return getDB()
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      currency: transactions.currency,
      reference: transactions.reference,
      counterpartyName: transactions.counterpartyName,
      counterpartyIban: transactions.counterpartyIban,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.bookingDate, from),
        lte(transactions.bookingDate, to),
      ),
    )
    .all();
}

/** Years with at least one transaction on a non-archived account, newest first. */
export function reviewYears(userId: string): number[] {
  const { active } = loadOwn(userId);
  const years = new Set<number>();
  for (const r of loadRows(userId, "0000-01-01", "9999-12-31")) {
    if (active.has(r.accountId)) years.add(Number(r.bookingDate.slice(0, 4)));
  }
  return [...years].sort((a, b) => b - a);
}

/** Last full year when it has data, otherwise the current year. */
export function defaultReviewYear(today: string, years: number[]): number {
  const last = Number(today.slice(0, 4)) - 1;
  return years.includes(last) ? last : Number(today.slice(0, 4));
}

/**
 * Income, expenses and where the money went for a calendar year, per
 * currency (account currency, no FX), compared with the year before.
 *
 * Only non-archived accounts count. Transfers between the user's own
 * accounts are left out: rows in a linked transfer (paired or mirrored) and,
 * for rows that are not linked, the heuristic in `loadTransferExclusion`
 * (counterparty IBAN of another own account, or a pillar 3a deposit
 * reference); those without a counterparty IBAN or reference cannot be
 * recognised. A transaction counts as income when it is
 * positive and as an expense when it is negative, except that its category
 * decides the side: a refund on an expense category reduces that expense.
 * Subcategories roll up into their parent. A year that is still running
 * covers January up to `today`.
 */
export function yearReview(
  userId: string,
  { year, today }: { year: number; today: string },
): YearReview {
  const from = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const to = today < yearEnd ? today : yearEnd;
  const { active, exclusion } = loadOwn(userId);
  const cats = new Map<string, Cat>(
    getDB()
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        kind: categories.kind,
        color: categories.color,
      })
      .from(categories)
      .where(eq(categories.userId, userId))
      .all()
      .map((c) => [c.id, c]),
  );

  let excludedTransfers = 0;
  const classify = (row: Row, countExcluded: boolean): Classified | null => {
    const currency = active.get(row.accountId);
    if (currency === undefined) return null;
    if (exclusion.isTransfer(row)) {
      if (countExcluded) excludedTransfers += 1;
      return null;
    }
    const own = row.categoryId ? (cats.get(row.categoryId) ?? null) : null;
    const top =
      own && own.parentId !== null ? (cats.get(own.parentId) ?? own) : own;
    const side: Side = own ? own.kind : row.amount > 0 ? "income" : "expense";
    return {
      row,
      currency,
      side,
      flow: side === "income" ? row.amount : -row.amount,
      bucketKey: `${side}|${top?.id ?? ""}`,
      top,
      own,
    };
  };

  const current: Classified[] = [];
  for (const r of loadRows(userId, from, to)) {
    const c = classify(r, true);
    if (c) current.push(c);
  }
  const previous: Classified[] = [];
  for (const r of loadRows(userId, `${year - 1}-01-01`, `${year - 1}-12-31`)) {
    const c = classify(r, false);
    if (c) previous.push(c);
  }

  const buckets = (list: Classified[]) => {
    const out = new Map<string, Bucket>();
    for (const c of list) {
      const b = out.get(c.bucketKey) ?? {
        categoryId: c.top?.id ?? null,
        name: c.top?.name ?? UNCATEGORIZED,
        color: c.top?.color ?? null,
        side: c.side,
        amount: 0,
      };
      b.amount += c.flow;
      out.set(c.bucketKey, b);
    }
    return out;
  };

  const series = netWorthSeries(userId, {
    from: `${year - 1}-12-31`,
    to,
    step: "month",
    today,
  });

  const currencies = [...new Set(current.map((c) => c.currency))].sort();
  const result = currencies.map((currency): CurrencyReview => {
    const cur = current.filter((c) => c.currency === currency);
    const prev = previous.filter((c) => c.currency === currency);
    const curBuckets = buckets(cur);
    const prevBuckets = buckets(prev);

    const sum = (side: Side) =>
      [...curBuckets.values()]
        .filter((b) => b.side === side)
        .reduce((s, b) => s + b.amount, 0);
    const income = sum("income");
    const expenses = sum("expense");
    const net = income - expenses;

    const items = (side: Side): SankeyItem[] =>
      [...curBuckets.values()]
        .filter((b) => b.side === side)
        .map((b) => ({
          key: b.categoryId ?? "uncategorized",
          label: b.name,
          color: b.color,
          amount: b.amount,
          uncategorized: b.categoryId === null,
        }));

    const hasPreviousYear = prev.length > 0;
    const changes: CategoryChange[] = [];
    if (hasPreviousYear) {
      for (const key of new Set([
        ...curBuckets.keys(),
        ...prevBuckets.keys(),
      ])) {
        const c = curBuckets.get(key);
        const p = prevBuckets.get(key);
        const base = (c ?? p)!;
        const amount = c?.amount ?? 0;
        const before = p?.amount ?? 0;
        if (amount === 0 && before === 0) continue;
        changes.push({
          categoryId: base.categoryId,
          name: base.name,
          color: base.color,
          side: base.side,
          amount: minor(amount),
          previous: minor(before),
          change: minor(amount - before),
          changePct: before > 0 ? (amount - before) / before : null,
        });
      }
      changes.sort(
        (a, b) =>
          Math.abs(b.change) - Math.abs(a.change) ||
          a.name.localeCompare(b.name),
      );
    }

    const counterparties = new Map<
      string,
      { name: string; spent: number; count: number }
    >();
    for (const c of cur) {
      const name = c.row.counterpartyName?.trim();
      if (!name || c.side !== "expense") continue;
      const key = name.toLowerCase();
      const entry = counterparties.get(key) ?? { name, spent: 0, count: 0 };
      entry.spent += c.flow;
      entry.count += 1;
      counterparties.set(key, entry);
    }

    const large = (pick: (c: Classified) => boolean, sign: 1 | -1) =>
      cur
        .filter(pick)
        .sort(
          (a, b) =>
            sign * (b.row.amount - a.row.amount) ||
            a.row.bookingDate.localeCompare(b.row.bookingDate) ||
            a.row.id.localeCompare(b.row.id),
        )
        .slice(0, TOP_TRANSACTIONS)
        .map((c): LargeTransaction => ({
          id: c.row.id,
          bookingDate: c.row.bookingDate,
          amount: minor(c.row.amount),
          counterparty: c.row.counterpartyName,
          categoryName: c.own?.name ?? null,
        }));

    const months: MonthFlow[] = Array.from({ length: 12 }, (_, i) => {
      const month = `${year}-${String(i + 1).padStart(2, "0")}`;
      const { first, last } = monthBounds(month);
      let inc = 0;
      let exp = 0;
      for (const c of cur) {
        if (c.row.bookingDate < first || c.row.bookingDate > last) continue;
        if (c.side === "income") inc += c.flow;
        else exp += c.flow;
      }
      return { month, income: minor(inc), expenses: minor(exp) };
    });

    const points = series.find((s) => s.currency === currency)?.points;
    const start = points?.[0];
    const end = points?.[points.length - 1];

    return {
      currency,
      income: minor(income),
      expenses: minor(expenses),
      net: minor(net),
      savingsRate: income > 0 ? net / income : null,
      netWorth:
        start && end
          ? {
              start: start.amount,
              end: end.amount,
              change: minor(end.amount - start.amount),
            }
          : null,
      hasPreviousYear,
      sankey: buildSankeyGraph(items("income"), items("expense")),
      changes: changes.slice(0, TOP_CHANGES),
      counterparties: [...counterparties.values()]
        .filter((c) => c.spent > 0)
        .sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name))
        .slice(0, TOP_COUNTERPARTIES)
        .map((c) => ({ ...c, spent: minor(c.spent) })),
      largestExpenses: large((c) => c.row.amount < 0, -1),
      largestIncome: large((c) => c.row.amount > 0, 1),
      months,
    };
  });

  return {
    year,
    from,
    to,
    partial: to < yearEnd,
    excludedTransfers,
    currencies: result,
  };
}
