import { FULL_SHARE_BPS } from "$lib/money";
import { readSnapshot } from "$lib/server/db";
import {
  accountBalances,
  balanceTotals,
  lastImports,
  type AccountBalanceView,
  type CurrencyTotal,
  type LastImportView,
} from "./accounts";
import {
  billsSummary,
  unmatchedTransactions,
  type BillsSummary,
  type UnmatchedHint,
} from "./bills";
import {
  spendingByCategory,
  type SpendingSummary,
} from "$lib/server/categories/budgets";
import { investedTotals, type InvestedTotal } from "./invested";
import { liquidity, type CurrencyLiquidity } from "./liquidity";
import { monthSummary, type MonthSummary } from "./month";
import {
  earliestDataDate,
  netWorthSeries,
  type NetWorthCurrencySeries,
} from "./net-worth";
import { parseRange, rangeWindow, type DashboardRange } from "./range";

export * from "./accounts";
export * from "./bills";
export * from "./invested";
export * from "./liquidity";
export * from "./month";
export * from "./net-worth";
export * from "./range";
export { addDays, addMonths, monthBounds, type NetWorthStep } from "./dates";

export interface Dashboard {
  today: string;
  range: DashboardRange;
  /** True when at least one active account has an ownership share below 100%. */
  hasShared: boolean;
  netWorth: {
    from: string;
    to: string;
    step: "month" | "week" | "day";
    /** Every account at 100%. */
    series: NetWorthCurrencySeries[];
    /** Every account at its ownership share; null without shared accounts. */
    shareSeries: NetWorthCurrencySeries[] | null;
    /** Current total per currency (sum of `accounts`), also at share. */
    totals: CurrencyTotal[];
  };
  accounts: AccountBalanceView[];
  /**
   * Money available now and behind notice periods, per currency, at the
   * ownership share (`shareBalance`; `balance` is the full amount).
   */
  liquidity: CurrencyLiquidity[];
  /** Securities holdings per currency; empty without holdings. */
  invested: InvestedTotal[];
  /** Income and expenses with every transaction at 100%. */
  month: MonthSummary;
  /** The same month at the ownership share; null without shared accounts. */
  shareMonth: MonthSummary | null;
  /** Spending by category at the ownership share (equals the total without shared accounts). */
  spending: SpendingSummary;
  /** Spending by category at 100%; null without shared accounts. */
  spendingTotal: SpendingSummary | null;
  bills: BillsSummary;
  unmatched: UnmatchedHint;
  imports: LastImportView[];
  /** Accounts whose data is stale. */
  staleAccounts: number;
  overdueBills: number;
}

export async function dashboard(
  userId: string,
  today: string,
  options: { range?: string | null } = {},
): Promise<Dashboard> {
  // Every figure on the page comes from one state of the database, so the
  // net worth, the accounts and the month summary agree with each other.
  return readSnapshot(() => dashboardSnapshot(userId, today, options));
}

async function dashboardSnapshot(
  userId: string,
  today: string,
  options: { range?: string | null },
): Promise<Dashboard> {
  const range = parseRange(options.range);
  const window = rangeWindow(
    range,
    today,
    range === "all" ? await earliestDataDate(userId) : null,
  );
  const accounts = await accountBalances(userId, today);
  const bills = await billsSummary(userId, today);
  const hasShared = accounts.some((a) => a.shareBps < FULL_SHARE_BPS);
  const month = today.slice(0, 7);
  return {
    today,
    range,
    hasShared,
    netWorth: {
      ...window,
      series: await netWorthSeries(userId, { ...window, today }),
      shareSeries: hasShared
        ? await netWorthSeries(userId, { ...window, today, basis: "share" })
        : null,
      totals: balanceTotals(accounts),
    },
    accounts,
    liquidity: await liquidity(userId, today, accounts),
    invested: investedTotals(accounts),
    month: await monthSummary(userId, { month }),
    shareMonth: hasShared
      ? await monthSummary(userId, { month, basis: "share" })
      : null,
    spending: await spendingByCategory(userId, month, "share"),
    spendingTotal: hasShared
      ? await spendingByCategory(userId, month, "total")
      : null,
    bills,
    unmatched: await unmatchedTransactions(userId, { days: 60, today }),
    imports: await lastImports(userId, today, accounts),
    staleAccounts: accounts.filter((a) => a.stale).length,
    overdueBills: bills.overdue.count,
  };
}
