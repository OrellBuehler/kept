import { CADENCE_PER_YEAR, type Cadence } from "$lib/recurring-types";
import { normalizeIban } from "$lib/iban";
import { minor, type Minor } from "$lib/money";
import { addDays, addMonths, daysBetween } from "$lib/server/dashboard/dates";

export interface DetectInput {
  bookingDate: string;
  amount: Minor;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
  reversal: boolean;
}

export interface DetectedSeries {
  /** Payee identity + currency + direction; stable across runs. */
  key: string;
  name: string;
  counterpartyIban: string | null;
  cadence: Cadence;
  currency: string;
  /** Signed: negative for payments, positive for income. Equals `lastAmount`. */
  amount: Minor;
  firstDate: string;
  lastDate: string;
  lastAmount: Minor;
  /** Amount of the occurrence before the last one. */
  previousAmount: Minor;
  occurrences: number;
}

interface CadenceRule {
  /** Average days between occurrences. */
  days: number;
  /** Allowed deviation of a gap, in days, per cadence step. */
  tolerance: number;
  /** Occurrences needed before a series is suggested. */
  minOccurrences: number;
}

const RULES: Record<Cadence, CadenceRule> = {
  weekly: { days: 7, tolerance: 2, minOccurrences: 4 },
  monthly: { days: 30.44, tolerance: 5, minOccurrences: 3 },
  quarterly: { days: 91.31, tolerance: 8, minOccurrences: 3 },
  yearly: { days: 365.25, tolerance: 12, minOccurrences: 2 },
};

/** A gap of up to this many cadence steps still fits (MAX_STEPS - 1 skipped payments). */
const MAX_STEPS = 3;
/** Share of gaps that must match the cadence (a missed payment still matches). */
const MIN_FIT = 0.75;
/** Share of gaps that must be exactly one cadence step. */
const MIN_EXACT = 0.5;
/** Amounts further than this fraction from the median are not part of the series. */
const AMOUNT_TOLERANCE = 0.25;
/** A payment and an opposite one of the same size within this many days cancel out. */
const REFUND_WINDOW_DAYS = 45;
/** A price change smaller than this fraction of the previous amount is noise. */
const PRICE_CHANGE_THRESHOLD = 0.01;

function words(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "" && !/^\d+$/.test(w))
    .join(" ");
}

/** Identity of the payee: IBAN, else counterparty name, else the description. */
export function counterpartyKey(
  t: Pick<DetectInput, "counterpartyIban" | "counterpartyName" | "description">,
): string | null {
  const iban = t.counterpartyIban ? normalizeIban(t.counterpartyIban) : "";
  if (iban) return `iban:${iban}`;
  const name = t.counterpartyName ? words(t.counterpartyName) : "";
  if (name) return `name:${name}`;
  const description = t.description ? words(t.description) : "";
  return description ? `desc:${description}` : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Drops payments that were cancelled: reversal rows, and refunds that match an
 * earlier payment of the same size in the opposite direction.
 */
function cancelOut(rows: DetectInput[]): DetectInput[] {
  const sorted = [...rows].sort((a, b) =>
    a.bookingDate.localeCompare(b.bookingDate),
  );
  const gone = new Set<DetectInput>();
  sorted.forEach((later, i) => {
    if (gone.has(later)) return;
    for (let j = i - 1; j >= 0; j--) {
      const earlier = sorted[j]!;
      const age = daysBetween(earlier.bookingDate, later.bookingDate);
      if (age > REFUND_WINDOW_DAYS) break;
      if (gone.has(earlier)) continue;
      if (earlier.amount === -later.amount) {
        gone.add(earlier);
        gone.add(later);
        return;
      }
    }
  });
  return sorted.filter((t) => !gone.has(t) && !t.reversal);
}

function fitCadence(dates: string[]): Cadence | null {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  let best: { cadence: Cadence; exact: number } | null = null;
  for (const cadence of Object.keys(RULES) as Cadence[]) {
    const rule = RULES[cadence];
    if (dates.length < rule.minOccurrences) continue;
    const maxSteps = cadence === "yearly" ? 1 : MAX_STEPS;
    let fits = 0;
    let exact = 0;
    for (const gap of gaps) {
      const steps = Math.round(gap / rule.days);
      if (steps < 1 || steps > maxSteps) continue;
      if (Math.abs(gap - steps * rule.days) > rule.tolerance * steps) continue;
      fits++;
      if (steps === 1) exact++;
    }
    if (fits / gaps.length < MIN_FIT || exact / gaps.length < MIN_EXACT) {
      continue;
    }
    if (!best || exact > best.exact) best = { cadence, exact };
  }
  return best?.cadence ?? null;
}

/**
 * Finds regular payments. Transactions are grouped by payee (IBAN, else name,
 * else description), currency and direction. Within a group, payments whose
 * amount is far from the median are ignored, refunds and reversals cancel the
 * payment they belong to, and the remaining dates must follow a weekly,
 * monthly, quarterly or yearly rhythm. Skipped occurrences are tolerated.
 */
export function detectSeries(transactions: DetectInput[]): DetectedSeries[] {
  const groups = new Map<string, DetectInput[]>();
  for (const t of transactions) {
    const payee = counterpartyKey(t);
    if (payee === null || t.amount === 0) continue;
    const bucket = `${payee}|${t.currency}`;
    const list = groups.get(bucket);
    if (list) list.push(t);
    else groups.set(bucket, [t]);
  }

  const out: DetectedSeries[] = [];
  for (const [bucket, rows] of groups) {
    const settled = cancelOut(rows);
    for (const sign of [-1, 1]) {
      const side = settled.filter((t) => Math.sign(t.amount) === sign);
      if (side.length < 2) continue;
      const mid = median(side.map((t) => Math.abs(t.amount)));
      const kept = side.filter(
        (t) => Math.abs(Math.abs(t.amount) - mid) <= mid * AMOUNT_TOLERANCE,
      );
      const dates = kept.map((t) => t.bookingDate);
      const cadence = fitCadence(dates);
      if (!cadence) continue;
      const last = kept[kept.length - 1]!;
      const previous = kept[kept.length - 2]!;
      const named = [...kept].reverse().find((t) => t.counterpartyName?.trim());
      const fallback = bucket.split("|")[0]!.replace(/^[a-z]+:/, "");
      out.push({
        key: `${bucket}|${sign < 0 ? "out" : "in"}`,
        name: (named?.counterpartyName ?? last.description ?? fallback)
          .trim()
          .slice(0, 100),
        counterpartyIban: last.counterpartyIban
          ? normalizeIban(last.counterpartyIban)
          : null,
        cadence,
        currency: last.currency,
        amount: last.amount,
        firstDate: dates[0]!,
        lastDate: last.bookingDate,
        lastAmount: last.amount,
        previousAmount: previous.amount,
        occurrences: kept.length,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The n-th occurrence after `last`, counted from `last` so month-end clamping never drifts. */
export function occurrenceAfter(
  last: string,
  cadence: Cadence,
  n: number,
): string {
  switch (cadence) {
    case "weekly":
      return addDays(last, 7 * n);
    case "monthly":
      return addMonths(last, n);
    case "quarterly":
      return addMonths(last, 3 * n);
    case "yearly":
      return addMonths(last, 12 * n);
  }
}

/** Dates in [from, to] (inclusive) on which the series is expected after `last`. */
export function expectedDates(
  last: string,
  cadence: Cadence,
  from: string,
  to: string,
): string[] {
  const out: string[] = [];
  for (let n = 1; ; n++) {
    const date = occurrenceAfter(last, cadence, n);
    if (date > to) break;
    if (date >= from) out.push(date);
  }
  return out;
}

export function annualCost(amount: Minor, cadence: Cadence): Minor {
  return minor(amount * CADENCE_PER_YEAR[cadence]);
}

export function monthlyCost(amount: Minor, cadence: Cadence): Minor {
  return minor(Math.round(annualCost(amount, cadence) / 12));
}

export interface PriceChange {
  previous: Minor;
  latest: Minor;
  /** latest - previous, signed like the amounts. */
  delta: Minor;
}

/** Set when the latest amount differs from the previous one by more than 1%. */
export function priceChange(
  latest: Minor,
  previous: Minor | null,
): PriceChange | null {
  if (previous === null || previous === 0) return null;
  const delta = latest - previous;
  if (Math.abs(delta) <= Math.abs(previous) * PRICE_CHANGE_THRESHOLD) {
    return null;
  }
  return { previous, latest, delta: minor(delta) };
}
