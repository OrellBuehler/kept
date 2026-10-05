import { and, eq, inArray, lte } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  first,
  getDB,
  portfolios as portfolioRows,
  readSnapshot,
  transactions,
} from "$lib/server/db";
import { loadHoldingsInputs } from "$lib/server/investments/load";
import {
  makeHoldingsValueAt,
  type HoldingsInput,
  type HoldingsValue,
  type Position,
} from "$lib/server/investments/valuation";
import { loadPortfolioInputs } from "$lib/server/pillar3a/load";
import {
  makePortfoliosValueAt,
  type PortfoliosInput,
} from "$lib/server/pillar3a/valuation";
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
 * - Holdings (securities bought through trades, see investments/valuation.ts)
 *   come on top: the balance of an account with `holdings` is the cash balance
 *   above plus the value of its holdings on D, already converted into the
 *   account's currency. Trades never change the cash balance.
 * - With the account's "trades move cash" setting on, every buy lowers and
 *   every sell raises the cash balance by the trade's `amount` (account
 *   currency, fees included) on the trade date, exactly like a transaction:
 *   only trades dated after the latest snapshot (and not before the opening
 *   date) count, splits move no cash. Holdings are unchanged, so cash plus
 *   holdings does not count the same money twice.
 * - Pillar 3a portfolios (values entered by hand, see pillar3a/valuation.ts)
 *   come on top as well: per portfolio the latest value dated <= D, and 0 from
 *   the portfolio's closing date on.
 * - A pillar 3a account with at least one portfolio is worth its portfolios
 *   alone (`portfolioOnly`) from the date of its first portfolio value on: the
 *   hand-entered values already contain the deposits, so cash (opening balance,
 *   transactions, snapshots) and any holdings are left out, which would count
 *   the same money twice. Before that date, and without portfolios, a 3a
 *   account behaves like any other, so its earlier history is kept.
 * - Amounts are in the account's currency; securities in other currencies are
 *   converted inside the holdings valuation, nowhere else.
 */

export interface BalanceInput {
  openingBalance: number;
  openingDate: string | null;
  snapshots: readonly { date: string; amount: number; source?: string }[];
  transactions: readonly { bookingDate: string; amount: number }[];
  /** Signed cash movements of trades (buy negative, sell positive); see `cashMovesOf`. */
  cashMoves?: readonly CashMove[];
  holdings?: HoldingsInput;
  portfolios?: PortfoliosInput;
  /** Value the account by its portfolios alone; see `portfolioOnlyAccounts`. */
  portfolioOnly?: boolean;
}

export interface CashMove {
  date: string;
  amount: number;
}

export type BalanceAt = (date: string) => Minor;

/**
 * The cash a position's trades moved: a buy pays its `amount`, a sell receives
 * it, a split moves nothing. Use it for accounts with "trades move cash" on.
 */
export function cashMovesOf(holdings: HoldingsInput | undefined): CashMove[] {
  return (holdings?.trades ?? []).flatMap((t) =>
    t.side === "buy"
      ? [{ date: t.date, amount: -t.amount }]
      : t.side === "sell"
        ? [{ date: t.date, amount: t.amount }]
        : [],
  );
}

/** Transactions and trade cash movements as one dated list. */
export function ledgerMoves(
  input: Pick<BalanceInput, "transactions" | "cashMoves">,
): { bookingDate: string; amount: number }[] {
  return [
    ...input.transactions,
    ...(input.cashMoves ?? []).map((m) => ({
      bookingDate: m.date,
      amount: m.amount,
    })),
  ];
}

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
  const stacked = makeStackedBalanceAt(input);
  const from = input.portfolioOnly ? earliestPortfolioDate(input) : null;
  if (from === null) return stacked;
  const portfolios = makePortfoliosValueAt(input.portfolios!);
  // Before the first portfolio value the account was an ordinary one: its
  // history keeps the cash path instead of dropping to zero.
  return (date) => (date >= from ? portfolios(date) : stacked(date));
}

/** Date of the earliest portfolio value, or null without any. */
function earliestPortfolioDate(input: BalanceInput): string | null {
  let earliest: string | null = null;
  for (const p of input.portfolios ?? [])
    for (const v of p.values)
      if (earliest === null || v.date < earliest) earliest = v.date;
  return earliest;
}

/** True when the account is valued by its portfolios alone on `date`. */
function portfolioOnlyAt(input: BalanceInput, date: string): boolean {
  if (!input.portfolioOnly) return false;
  const from = earliestPortfolioDate(input);
  return from !== null && date >= from;
}

/** Cash plus holdings plus portfolios, whatever the account type. */
function makeStackedBalanceAt(input: BalanceInput): BalanceAt {
  const txs = ledgerMoves(input).sort((a, b) =>
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

  const cash = (date: string): Minor => {
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

  if (!input.holdings && !input.portfolios) return cash;
  const holdings = input.holdings ? makeHoldingsValueAt(input.holdings) : null;
  const portfolios = input.portfolios
    ? makePortfoliosValueAt(input.portfolios)
    : null;
  return (date) =>
    minor(
      cash(date) +
        (holdings ? holdings(date).value : 0) +
        (portfolios ? portfolios(date) : 0),
    );
}

/** Balance without the value of holdings and portfolios. */
export function cashBalanceAt(input: BalanceInput, date: string): Minor {
  return makeBalanceAt({
    ...input,
    portfolioOnly: false,
    holdings: undefined,
    portfolios: undefined,
  })(date);
}

/** The cash shown for an account: none for one valued by its portfolios alone. */
function shownCash(input: BalanceInput, date: string): Minor {
  return portfolioOnlyAt(input, date) ? minor(0) : cashBalanceAt(input, date);
}

/**
 * Of `accountIds`, the pillar 3a accounts that have at least one portfolio:
 * their value is the portfolio value alone (see the balance model above).
 */
export async function portfolioOnlyAccounts(
  userId: string,
  accountIds: readonly string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await getDB()
    .selectDistinct({ id: portfolioRows.accountId })
    .from(portfolioRows)
    .innerJoin(accounts, eq(accounts.id, portfolioRows.accountId))
    .where(
      and(
        eq(portfolioRows.userId, userId),
        eq(accounts.userId, userId),
        eq(accounts.type, "pillar_3a"),
        inArray(portfolioRows.accountId, [...accountIds]),
      ),
    );
  return new Set(rows.map((r) => r.id));
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

async function loadInput(
  userId: string,
  accountId: string,
  upTo: string | null,
  withValues: boolean,
): Promise<BalanceInput> {
  // One view for the several reads: a commit between them must not show up as
  // a balance that never existed.
  return readSnapshot(() =>
    loadInputSnapshot(userId, accountId, upTo, withValues),
  );
}

async function loadInputSnapshot(
  userId: string,
  accountId: string,
  upTo: string | null,
  withValues: boolean,
): Promise<BalanceInput> {
  const db = getDB();
  const account = await first(
    db
      .select({
        openingBalance: accounts.openingBalance,
        openingDate: accounts.openingDate,
        tradesMoveCash: accounts.tradesMoveCash,
      })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!account) throw notFound("Account");
  // Statements reconcile cash, so only the valuation reads leave it out.
  const portfolioOnly =
    withValues && (await portfolioOnlyAccounts(userId, [accountId])).size > 0;

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
  // Trades are needed for the cash part too when they move cash.
  const loaded =
    withValues || account.tradesMoveCash
      ? (
          await loadHoldingsInputs(userId, [accountId], upTo ?? "9999-12-31")
        ).get(accountId)
      : undefined;
  const holdings = withValues ? loaded : undefined;
  const portfolios = withValues
    ? (
        await loadPortfolioInputs(userId, [accountId], upTo ?? "9999-12-31")
      ).get(accountId)
    : undefined;
  return {
    openingBalance: account.openingBalance,
    openingDate: account.openingDate,
    holdings,
    cashMoves: account.tradesMoveCash ? cashMovesOf(loaded) : undefined,
    portfolios,
    portfolioOnly,
    transactions: await db
      .select({
        bookingDate: transactions.bookingDate,
        amount: transactions.amount,
      })
      .from(transactions)
      .where(and(...txWhere)),
    snapshots: await db
      .select({
        date: balanceSnapshots.date,
        amount: balanceSnapshots.amount,
        source: balanceSnapshots.source,
      })
      .from(balanceSnapshots)
      .where(and(...snapWhere)),
  };
}

/**
 * Cash balance at the end of `date` (see the model above), without holdings:
 * statements reconcile opening balance, transactions and closing balance.
 */
export async function accountBalanceAt(
  userId: string,
  accountId: string,
  date: string,
): Promise<Minor> {
  return balanceAt(await loadInput(userId, accountId, date, false), date);
}

export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Balance (cash plus holdings and portfolios; the portfolios alone for a 3a account with portfolio values) as of `today` (YYYY-MM-DD, default local
 * today): future-dated transactions, snapshots and trades do not count.
 */
export async function currentBalance(
  userId: string,
  accountId: string,
  today: string = localToday(),
): Promise<Minor> {
  return balanceAt(await loadInput(userId, accountId, today, true), today);
}

export interface AccountValue {
  cash: Minor;
  holdings: Minor;
  /** Pillar 3a portfolios, valued by hand. */
  portfolios: Minor;
  total: Minor;
  positions: Position[];
  /** At least one position is valued at cost because an FX rate is missing. */
  estimated: boolean;
}

/** Cash, holdings and portfolios of an account as of `today`; `total` is their sum, except that a 3a account with portfolio values is worth them alone. */
export async function accountValue(
  userId: string,
  accountId: string,
  today: string = localToday(),
): Promise<AccountValue> {
  const input = await loadInput(userId, accountId, today, true);
  const cash = shownCash(input, today);
  const held =
    input.holdings && !portfolioOnlyAt(input, today)
      ? makeHoldingsValueAt(input.holdings)(today)
      : null;
  const holdings = held?.value ?? minor(0);
  const portfolios = input.portfolios
    ? makePortfoliosValueAt(input.portfolios)(today)
    : minor(0);
  return {
    cash,
    holdings,
    portfolios,
    total: minor(cash + holdings + portfolios),
    positions: held?.positions ?? [],
    estimated: held?.estimated ?? false,
  };
}

/** Current balances (cash plus holdings and portfolios, see the model above) of several accounts with a handful of queries in total. */
export async function currentBalances(
  userId: string,
  accountRows: readonly {
    id: string;
    openingBalance: number;
    openingDate: string | null;
    tradesMoveCash: boolean;
  }[],
  today: string = localToday(),
): Promise<Map<string, Minor>> {
  return new Map(
    [...(await currentValues(userId, accountRows, today))].map(([id, v]) => [
      id,
      v.total,
    ]),
  );
}

export interface CurrentValue {
  /** Cash balance, without holdings and portfolios. */
  cash: Minor;
  /** Securities held through trades; null when the account has no trades. */
  holdings: HoldingsValue | null;
  /** Pillar 3a portfolios, valued by hand. */
  portfolios: Minor;
  /** Cash plus holdings plus portfolios (the portfolios alone for a 3a account with portfolio values). */
  total: Minor;
}

/** Per account: the cash balance, holdings and total as of `today`, with a handful of queries in total. */
export async function currentValues(
  userId: string,
  accountRows: readonly {
    id: string;
    openingBalance: number;
    openingDate: string | null;
    tradesMoveCash: boolean;
  }[],
  today: string = localToday(),
): Promise<Map<string, CurrentValue>> {
  return readSnapshot(() => currentValuesSnapshot(userId, accountRows, today));
}

async function currentValuesSnapshot(
  userId: string,
  accountRows: readonly {
    id: string;
    openingBalance: number;
    openingDate: string | null;
    tradesMoveCash: boolean;
  }[],
  today: string,
): Promise<Map<string, CurrentValue>> {
  const db = getDB();
  const txByAccount = new Map<string, BalanceInput["transactions"][number][]>();
  for (const t of await db
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
    )) {
    const list = txByAccount.get(t.accountId) ?? [];
    list.push(t);
    txByAccount.set(t.accountId, list);
  }
  const snapByAccount = new Map<string, BalanceInput["snapshots"][number][]>();
  for (const s of await db
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
    )) {
    const list = snapByAccount.get(s.accountId) ?? [];
    list.push(s);
    snapByAccount.set(s.accountId, list);
  }
  const holdings = await loadHoldingsInputs(
    userId,
    accountRows.map((a) => a.id),
    today,
  );
  const portfolios = await loadPortfolioInputs(
    userId,
    accountRows.map((a) => a.id),
    today,
  );
  const portfolioOnly = await portfolioOnlyAccounts(
    userId,
    accountRows.map((a) => a.id),
  );
  return new Map(
    accountRows.map((a) => {
      const input: BalanceInput = {
        openingBalance: a.openingBalance,
        openingDate: a.openingDate,
        transactions: txByAccount.get(a.id) ?? [],
        cashMoves: a.tradesMoveCash
          ? cashMovesOf(holdings.get(a.id))
          : undefined,
        snapshots: snapByAccount.get(a.id) ?? [],
        holdings: holdings.get(a.id),
        portfolios: portfolios.get(a.id),
        portfolioOnly: portfolioOnly.has(a.id),
      };
      const cash = shownCash(input, today);
      const held =
        input.holdings && !portfolioOnlyAt(input, today)
          ? makeHoldingsValueAt(input.holdings)(today)
          : null;
      const portfolioValue = input.portfolios
        ? makePortfoliosValueAt(input.portfolios)(today)
        : minor(0);
      return [
        a.id,
        {
          cash,
          holdings: held,
          portfolios: portfolioValue,
          total: minor(cash + (held?.value ?? 0) + portfolioValue),
        },
      ];
    }),
  );
}

export async function balanceSeries(
  userId: string,
  accountId: string,
  from: string,
  to: string,
  step: SeriesStep,
): Promise<BalancePoint[]> {
  return balanceSeriesOf(
    await loadInput(userId, accountId, to, true),
    from,
    to,
    step,
  );
}
