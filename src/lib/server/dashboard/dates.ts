import { seriesDates, type SeriesStep } from "$lib/server/ledger/balances";

export { daysBetween } from "$lib/server/bills/status";

const DAY_MS = 86_400_000;

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m!, d!];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Same day of the month `months` earlier/later; clamped to the month's last day. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last)))
    .toISOString()
    .slice(0, 10);
}

/** First and last day of a "YYYY-MM" month. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  return {
    first: `${month}-01`,
    last: new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10),
  };
}

export function previousMonth(month: string): string {
  return addMonths(`${month}-01`, -1).slice(0, 7);
}

export type NetWorthStep = SeriesStep | "week";

/**
 * Chart dates in [from, to]. Weekly points count back from `to` in steps of
 * seven days so the last point is always `to`.
 */
export function stepDates(
  from: string,
  to: string,
  step: NetWorthStep,
): string[] {
  if (step !== "week") return seriesDates(from, to, step);
  const out: string[] = [];
  for (let d = to; d >= from; d = addDays(d, -7)) out.push(d);
  return out.reverse();
}
