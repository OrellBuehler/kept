import { minor, type Minor } from "$lib/money";

/** Manually entered values of the portfolios of one account (pure, no DB access). */
export type PortfoliosInput = readonly {
  /** From this date on the portfolio no longer counts. */
  closedOn: string | null;
  values: readonly { date: string; amount: number }[];
}[];

/**
 * Value of the portfolios at the end of a date: per portfolio the newest value
 * dated on or before it, 0 before the first value and from `closedOn` on.
 */
export function makePortfoliosValueAt(
  portfolios: PortfoliosInput,
): (date: string) => Minor {
  const sorted = portfolios.map((p) => ({
    closedOn: p.closedOn,
    values: [...p.values].sort((a, b) => (a.date < b.date ? -1 : 1)),
  }));
  return (date) => {
    let total = 0;
    for (const p of sorted) {
      if (p.closedOn !== null && date >= p.closedOn) continue;
      let lo = 0;
      let hi = p.values.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (p.values[mid]!.date <= date) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) total += p.values[lo - 1]!.amount;
    }
    return minor(total);
  };
}
