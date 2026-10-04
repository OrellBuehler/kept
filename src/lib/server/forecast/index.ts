import type { Minor } from "$lib/money";
import { accountBalances } from "$lib/server/dashboard/accounts";
import { addDays } from "$lib/server/dashboard/dates";
import {
  billsToItems,
  loadBills,
  unprojectedBills,
  type UnprojectedBills,
} from "./bills";
import { listPlannedItems, plannedToItems } from "./planned";
import {
  projectForecast,
  type Forecast,
  type ForecastAccount,
  type ProjectedItem,
} from "./projection";
import { listAccountSettings } from "./settings";
import type { Horizon } from "./schemas";

export * from "./planned";
export * from "./projection";
export * from "./schemas";
export * from "./settings";
export { billsToItems, unprojectedBills } from "./bills";

/** Produces the expected movements in [from, to] for one user. */
export type ItemSource = (
  userId: string,
  from: string,
  to: string,
) => ProjectedItem[];

const billSource: ItemSource = (userId, from) =>
  billsToItems(loadBills(userId, from), from);

const plannedSource: ItemSource = (userId) =>
  plannedToItems(listPlannedItems(userId));

/**
 * Every source of projected items. To add another one (e.g. detected
 * recurring payments), append a function with the `ItemSource` signature:
 *   (userId, from, to) => projectRecurring(userId, from, to)
 */
export const itemSources: readonly ItemSource[] = [billSource, plannedSource];

export interface ForecastView extends Forecast {
  today: string;
  unprojectedBills: UnprojectedBills;
}

async function forecastAccounts(
  userId: string,
  today: string,
): Promise<ForecastAccount[]> {
  const settings = new Map(
    listAccountSettings(userId).map((s) => [s.accountId, s]),
  );
  return (await accountBalances(userId, today)).map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    balance: a.noData ? null : a.cashBalance,
    threshold: settings.get(a.id)?.threshold ?? null,
    defaultPayment: settings.get(a.id)?.defaultPayment ?? false,
  }));
}

export async function forecast(
  userId: string,
  today: string,
  days: Horizon | number,
): Promise<ForecastView> {
  const to = addDays(today, days);
  const items = itemSources.flatMap((source) => source(userId, today, to));
  return {
    ...projectForecast({
      accounts: await forecastAccounts(userId, today),
      items,
      from: today,
      days,
    }),
    today,
    unprojectedBills: unprojectedBills(loadBills(userId, today)),
  };
}

export interface LowBalanceAlert {
  accountId: string;
  name: string;
  currency: string;
  date: string;
  balance: Minor;
}

/** Accounts whose projected balance goes below zero within `days`, soonest first. */
export async function negativeBalanceAlerts(
  userId: string,
  today: string,
  days = 30,
): Promise<LowBalanceAlert[]> {
  return (await forecast(userId, today, days)).accounts
    .filter((a) => a.negativeDate !== null)
    .map((a) => {
      const point = a.points.find((p) => p.date === a.negativeDate)!;
      return {
        accountId: a.accountId,
        name: a.name,
        currency: a.currency,
        date: point.date,
        balance: point.balance,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
