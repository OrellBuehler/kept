import { and, eq, gte, lte } from "drizzle-orm";
import { normalizeIban } from "$lib/iban";
import { minor, shareOf, type Minor, type ShareBasis } from "$lib/money";
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
 * expense. With basis "share" every transaction is scaled by the ownership
 * share of its account (rounded per transaction, see `shareOf`); the transfer
 * check is unchanged. Amounts are bucketed by the account's currency (as in net worth). Income is the sum of positive amounts, expenses the sum of
 * negative ones (reversals are not netted against the original).
 */
export function monthSummary(
  userId: string,
  { month, basis = "total" }: { month: string; basis?: ShareBasis },
): MonthSummary {
  const db = getDB();
  const prev = previousMonth(month);
  const own = db
    .select({
      id: accounts.id,
      iban: accounts.iban,
      archived: accounts.archived,
      currency: accounts.currency,
      shareBps: accounts.shareBps,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all();
  const active = new Map(
    own.filter((a) => !a.archived).map((a) => [a.id, a.currency]),
  );
  const shareBpsOf = new Map(own.map((a) => [a.id, a.shareBps]));
  const ibanOwner = new Map<string, string>();
  for (const a of own) if (a.iban) ibanOwner.set(normalizeIban(a.iban), a.id);

  const rows = db
    .select({
      accountId: transactions.accountId,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
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
    const currency = active.get(t.accountId);
    if (currency === undefined) continue;
    if (t.counterpartyIban) {
      const owner = ibanOwner.get(normalizeIban(t.counterpartyIban));
      if (owner !== undefined && owner !== t.accountId) continue;
    }
    currencies.add(currency);
    const b = bucket(t.bookingDate.slice(0, 7), currency);
    const amount =
      basis === "share"
        ? shareOf(t.amount, shareBpsOf.get(t.accountId)!)
        : t.amount;
    if (amount > 0) b.income += amount;
    else b.expenses -= amount;
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
