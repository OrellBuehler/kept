import { minor, type Minor } from "$lib/money";
import { addDays } from "$lib/server/dashboard/dates";

/**
 * Cash-flow projection (pure, no DB)
 * ----------------------------------
 * - An item is an expected movement: negative amount = outflow, positive = inflow.
 * - Items are applied on their date; items dated before `from` (e.g. overdue
 *   bills) are treated as happening on `from`; items after the horizon are ignored.
 * - The balance on day D is the starting balance plus all items dated <= D, so
 *   the first point (`from`) already contains the items of that day.
 * - Currencies are never mixed. An item that names an account of another
 *   currency, an unknown account, or no account is assigned to the default
 *   payment account of its currency, or stays unassigned if there is none.
 * - An account without balance data starts from 0 and is flagged `hasBalance:
 *   false`; it gets no low-balance warning because the starting point is unknown.
 */

export interface ProjectedItem {
  date: string;
  amount: Minor;
  currency: string;
  accountId: string | null;
  /** Which source produced the item, e.g. "bill" or "planned". */
  source: string;
  label: string;
  /** Id of the underlying record in its source, when it has one. */
  ref?: string;
}

export interface ForecastAccount {
  id: string;
  name: string;
  currency: string;
  /** Current balance; null when the account has no data yet. */
  balance: Minor | null;
  /** Warn when the balance drops below this; null means 0. */
  threshold: Minor | null;
  defaultPayment: boolean;
}

export interface BalancePoint {
  date: string;
  balance: Minor;
}

export interface LowBalanceWarning {
  /** First day the projected balance is below `limit`. */
  date: string;
  balance: Minor;
  limit: Minor;
  /** The balance is below zero (not just below the threshold). */
  negative: boolean;
}

export interface AccountProjection {
  accountId: string;
  name: string;
  currency: string;
  hasBalance: boolean;
  startBalance: Minor;
  endBalance: Minor;
  threshold: Minor | null;
  points: BalancePoint[];
  lowest: BalancePoint;
  warning: LowBalanceWarning | null;
  /** First day the balance is below zero, if any. */
  negativeDate: string | null;
}

export interface UnassignedTotal {
  currency: string;
  inflow: Minor;
  outflow: Minor;
  count: number;
}

export interface Forecast {
  from: string;
  to: string;
  days: number;
  accounts: AccountProjection[];
  /** Items in the horizon with the account they were assigned to, by date. */
  items: ProjectedItem[];
  unassigned: UnassignedTotal[];
}

export function compareItems(a: ProjectedItem, b: ProjectedItem): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.amount !== b.amount) return a.amount - b.amount;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** Resolves each item's account (see the model above); keeps the input untouched. */
export function assignAccounts(
  items: readonly ProjectedItem[],
  accounts: readonly ForecastAccount[],
): ProjectedItem[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const defaults = new Map<string, string>();
  for (const a of accounts) {
    if (a.defaultPayment && !defaults.has(a.currency)) {
      defaults.set(a.currency, a.id);
    }
  }
  return items.map((item) => {
    const own = item.accountId === null ? undefined : byId.get(item.accountId);
    const accountId =
      own && own.currency === item.currency
        ? own.id
        : (defaults.get(item.currency) ?? null);
    return { ...item, accountId };
  });
}

function projectAccount(
  account: ForecastAccount,
  items: readonly ProjectedItem[],
  from: string,
  to: string,
): AccountProjection {
  const delta = new Map<string, number>();
  for (const item of items) {
    delta.set(item.date, (delta.get(item.date) ?? 0) + item.amount);
  }
  const hasBalance = account.balance !== null;
  const startBalance = account.balance ?? minor(0);
  const limit = account.threshold ?? minor(0);

  const points: BalancePoint[] = [];
  let running: number = startBalance;
  let lowest: BalancePoint | null = null;
  let warning: LowBalanceWarning | null = null;
  let negativeDate: string | null = null;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    running += delta.get(date) ?? 0;
    const point = { date, balance: minor(running) };
    points.push(point);
    if (lowest === null || running < lowest.balance) lowest = point;
    if (hasBalance) {
      if (negativeDate === null && running < 0) negativeDate = date;
      if (warning === null && running < limit) {
        warning = {
          date,
          balance: point.balance,
          limit,
          negative: running < 0,
        };
      }
    }
  }
  return {
    accountId: account.id,
    name: account.name,
    currency: account.currency,
    hasBalance,
    startBalance,
    endBalance: points[points.length - 1]!.balance,
    threshold: account.threshold,
    points,
    lowest: lowest!,
    warning,
    negativeDate,
  };
}

export function projectForecast(input: {
  accounts: readonly ForecastAccount[];
  items: readonly ProjectedItem[];
  from: string;
  days: number;
}): Forecast {
  const { accounts, from, days } = input;
  const to = addDays(from, days);
  const inHorizon = assignAccounts(input.items, accounts)
    .filter((i) => i.date <= to)
    .map((i) => (i.date < from ? { ...i, date: from } : i))
    .sort(compareItems);

  const byAccount = new Map<string, ProjectedItem[]>();
  const unassigned = new Map<string, UnassignedTotal>();
  for (const item of inHorizon) {
    if (item.accountId !== null) {
      const list = byAccount.get(item.accountId);
      if (list) list.push(item);
      else byAccount.set(item.accountId, [item]);
      continue;
    }
    const total = unassigned.get(item.currency) ?? {
      currency: item.currency,
      inflow: minor(0),
      outflow: minor(0),
      count: 0,
    };
    if (item.amount > 0) total.inflow = minor(total.inflow + item.amount);
    else total.outflow = minor(total.outflow + item.amount);
    total.count += 1;
    unassigned.set(item.currency, total);
  }

  return {
    from,
    to,
    days,
    accounts: accounts.map((a) =>
      projectAccount(a, byAccount.get(a.id) ?? [], from, to),
    ),
    items: inHorizon,
    unassigned: [...unassigned.values()].sort((a, b) =>
      a.currency < b.currency ? -1 : 1,
    ),
  };
}
