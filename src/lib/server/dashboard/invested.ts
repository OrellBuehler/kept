import { minor, shareOf, type Minor } from "$lib/money";
import type { AccountBalanceView } from "./accounts";

export interface InvestedTotal {
  currency: string;
  /** Market value of the securities (account currency). */
  value: Minor;
  /** Remaining cost basis. */
  cost: Minor;
  /** `value - cost`. */
  gain: Minor;
  /** `value` at the ownership share. */
  shareValue: Minor;
  /** `gain` at the ownership share (`shareValue` minus the shared cost). */
  shareGain: Minor;
  accountCount: number;
  /** At least one position is valued at cost because an FX rate is missing. */
  estimated: boolean;
}

/** Securities holdings per account currency; accounts without holdings are skipped. */
export function investedTotals(
  accounts: readonly Pick<
    AccountBalanceView,
    "currency" | "holdings" | "shareBps"
  >[],
): InvestedTotal[] {
  const totals = new Map<
    string,
    {
      value: number;
      cost: number;
      shareValue: number;
      shareCost: number;
      n: number;
      estimated: boolean;
    }
  >();
  for (const a of accounts) {
    const h = a.holdings;
    if (!h || (h.value === 0 && h.cost === 0)) continue;
    const t = totals.get(a.currency) ?? {
      value: 0,
      cost: 0,
      shareValue: 0,
      shareCost: 0,
      n: 0,
      estimated: false,
    };
    t.value += h.value;
    t.cost += h.cost;
    t.shareValue += shareOf(h.value, a.shareBps);
    t.shareCost += shareOf(h.cost, a.shareBps);
    t.n += 1;
    t.estimated ||= h.estimated;
    totals.set(a.currency, t);
  }
  return [...totals.keys()].sort().map((currency) => {
    const t = totals.get(currency)!;
    return {
      currency,
      value: minor(t.value),
      cost: minor(t.cost),
      gain: minor(t.value - t.cost),
      shareValue: minor(t.shareValue),
      shareGain: minor(t.shareValue - t.shareCost),
      accountCount: t.n,
      estimated: t.estimated,
    };
  });
}
