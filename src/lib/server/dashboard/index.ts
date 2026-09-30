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
  netWorth: {
    from: string;
    to: string;
    step: "month" | "week" | "day";
    series: NetWorthCurrencySeries[];
    /** Current total per currency (sum of `accounts`). */
    totals: CurrencyTotal[];
  };
  accounts: AccountBalanceView[];
  month: MonthSummary;
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
  return {
    today,
    range,
    netWorth: {
      ...window,
      series: netWorthSeries(userId, { ...window, today }),
      totals: balanceTotals(accounts),
    },
    accounts,
    month: monthSummary(userId, { month: today.slice(0, 7) }),
    bills,
    unmatched: unmatchedTransactions(userId, { days: 60, today }),
    imports: lastImports(userId, today, accounts),
    staleAccounts: accounts.filter((a) => a.stale).length,
    overdueBills: bills.overdue.count,
  };
}
