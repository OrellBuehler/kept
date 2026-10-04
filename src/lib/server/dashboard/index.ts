import { FULL_SHARE_BPS } from "$lib/money";
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
import { monthSummary, type MonthSummary } from "./month";
import {
  earliestDataDate,
  netWorthSeries,
  type NetWorthCurrencySeries,
} from "./net-worth";
import { parseRange, rangeWindow, type DashboardRange } from "./range";

export * from "./accounts";
export * from "./bills";
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

export function dashboard(
  userId: string,
  today: string,
  options: { range?: string | null } = {},
): Dashboard {
  const range = parseRange(options.range);
  const window = rangeWindow(
    range,
    today,
    range === "all" ? earliestDataDate(userId) : null,
  );
  const accounts = accountBalances(userId, today);
  const bills = billsSummary(userId, today);
  const hasShared = accounts.some((a) => a.shareBps < FULL_SHARE_BPS);
  const month = today.slice(0, 7);
  return {
    today,
    range,
    hasShared,
    netWorth: {
      ...window,
      series: netWorthSeries(userId, { ...window, today }),
      shareSeries: hasShared
        ? netWorthSeries(userId, { ...window, today, basis: "share" })
        : null,
      totals: balanceTotals(accounts),
    },
    accounts,
    month: monthSummary(userId, { month }),
    shareMonth: hasShared
      ? monthSummary(userId, { month, basis: "share" })
      : null,
    spending: spendingByCategory(userId, month, "share"),
    spendingTotal: hasShared
      ? spendingByCategory(userId, month, "total")
      : null,
    bills,
    unmatched: unmatchedTransactions(userId, { days: 60, today }),
    imports: lastImports(userId, today, accounts),
    staleAccounts: accounts.filter((a) => a.stale).length,
    overdueBills: bills.overdue.count,
  };
}
