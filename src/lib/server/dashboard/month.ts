import { and, eq, gte, lte } from "drizzle-orm";
import { normalizeIban } from "$lib/iban";
import { minor, type Minor } from "$lib/money";
import { accounts, getDB, transactions } from "$lib/server/db";
import { monthBounds, previousMonth } from "./dates";

export interface CurrencyMonthTotals {
  currency: string;
  income: Minor;
  /** Positive number. */
  expenses: Minor;
  /** income - expenses. */
  net: Minor;
}

export interface MonthSummary {
  month: string;
  previousMonth: string;
  /** Same currencies, in the same order, in both lists (zeros where a month has none). */
  totals: CurrencyMonthTotals[];
  previousTotals: CurrencyMonthTotals[];
}

/**
 * Income and expenses of a "YYYY-MM" month on non-archived accounts, per
 * currency, plus the previous month for comparison.
 *
 * Transfers between the user's own accounts are excluded. Heuristic: a
 * transaction whose counterparty IBAN equals the IBAN of another account of
 * the same user (archived ones included) is a transfer. Transfers whose
 * counterparty carries no IBAN cannot be recognised and count as income or
 * expense. Income is the sum of positive amounts, expenses the sum of
 * negative ones (reversals are not netted against the original).
 */
export function monthSummary(
  userId: string,
  { month }: { month: string; today?: string },
): MonthSummary {
  const db = getDB();
  const prev = previousMonth(month);
  const own = db
    .select({
      id: accounts.id,
      iban: accounts.iban,
      archived: accounts.archived,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all();
  const active = new Set(own.filter((a) => !a.archived).map((a) => a.id));
  const ibanOwner = new Map<string, string>();
  for (const a of own) if (a.iban) ibanOwner.set(normalizeIban(a.iban), a.id);

  const rows = db
    .select({
      accountId: transactions.accountId,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      currency: transactions.currency,
      counterpartyIban: transactions.counterpartyIban,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.bookingDate, monthBounds(prev).first),
        lte(transactions.bookingDate, monthBounds(month).last),
      ),
    )
    .all();

  const acc = new Map<string, { income: number; expenses: number }>();
  const bucket = (m: string, currency: string) => {
    const key = `${m}|${currency}`;
    let b = acc.get(key);
    if (!b) {
      b = { income: 0, expenses: 0 };
      acc.set(key, b);
    }
    return b;
  };
  const currencies = new Set<string>();
  for (const t of rows) {
    if (!active.has(t.accountId)) continue;
    if (t.counterpartyIban) {
      const owner = ibanOwner.get(normalizeIban(t.counterpartyIban));
      if (owner !== undefined && owner !== t.accountId) continue;
    }
    currencies.add(t.currency);
    const b = bucket(t.bookingDate.slice(0, 7), t.currency);
    if (t.amount > 0) b.income += t.amount;
    else b.expenses -= t.amount;
  }

  const sorted = [...currencies].sort();
  const totalsFor = (m: string): CurrencyMonthTotals[] =>
    sorted.map((currency) => {
      const b = acc.get(`${m}|${currency}`) ?? { income: 0, expenses: 0 };
      return {
        currency,
        income: minor(b.income),
        expenses: minor(b.expenses),
        net: minor(b.income - b.expenses),
      };
    });
  return {
    month,
    previousMonth: prev,
    totals: totalsFor(month),
    previousTotals: totalsFor(prev),
  };
}
