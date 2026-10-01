import { minor, type Minor } from "$lib/money";

/** Payments on the tax office's side usually post a few days after yours. */
export const DEFAULT_DATE_TOLERANCE_DAYS = 7;

/** A payment that counts as "paid by me" (positive: paid, negative: refund received). */
export interface MineLine {
  id: string;
  date: string;
  amount: Minor;
  reference: string | null;
}

/** A line of the tax office's statement (positive: counted, negative: repaid). */
export interface OfficeLine {
  id: string;
  date: string;
  amount: Minor;
  reference: string | null;
}

export type PairReason =
  "reference" | "amount_date" | "reference_amount" | "date";

export interface LinePair<M extends MineLine, O extends OfficeLine> {
  mine: M;
  office: O;
  /** `amount_mismatch` when the pair belongs together but the amounts differ. */
  status: "matched" | "amount_mismatch";
  /** mine - office: positive means you paid more than they counted. */
  difference: Minor;
  reason: PairReason;
}

export interface LineMatching<M extends MineLine, O extends OfficeLine> {
  pairs: LinePair<M, O>[];
  /** Missing on the tax office's side. */
  mineOnly: M[];
  /** Missing on your side. */
  officeOnly: O[];
}

export interface MatchOptions {
  dateToleranceDays?: number;
}

const DAY_MS = 86_400_000;

export function dayDistance(a: string, b: string): number {
  const ms = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y!, m! - 1, day!);
  };
  return Math.abs(Math.round((ms(a) - ms(b)) / DAY_MS));
}

const normalizeRef = (ref: string | null): string | null => {
  const r = ref?.replace(/\s+/g, "").toUpperCase() ?? "";
  return r === "" ? null : r;
};

interface Candidate {
  mi: number;
  oi: number;
  distance: number;
}

/**
 * Pairs your payments with the tax office's lines. Each pass pairs the closest
 * dates first and only looks at lines the earlier passes left over:
 *
 *  1. same reference and same amount (any date: instalments often share one)
 *  2. same amount, dates within the tolerance
 *  3. same reference, different amount (any date)           -> amount mismatch
 *  4. different amount, dates within the tolerance, and no  -> amount mismatch
 *     two references that contradict each other
 *
 * Amounts are compared exactly, in minor units. Input order breaks ties, so
 * the result is deterministic.
 */
export function matchLines<M extends MineLine, O extends OfficeLine>(
  mine: readonly M[],
  office: readonly O[],
  opts: MatchOptions = {},
): LineMatching<M, O> {
  const tolerance = opts.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  const usedMine = new Set<number>();
  const usedOffice = new Set<number>();
  const pairs: LinePair<M, O>[] = [];

  const passes: {
    reason: PairReason;
    eligible: (m: M, o: O, distance: number) => boolean;
  }[] = [
    {
      reason: "reference_amount",
      eligible: (m, o) => {
        const ref = normalizeRef(m.reference);
        return (
          ref !== null &&
          ref === normalizeRef(o.reference) &&
          m.amount === o.amount
        );
      },
    },
    {
      reason: "amount_date",
      eligible: (m, o, d) => m.amount === o.amount && d <= tolerance,
    },
    {
      reason: "reference",
      eligible: (m, o) => {
        const ref = normalizeRef(m.reference);
        return ref !== null && ref === normalizeRef(o.reference);
      },
    },
    {
      reason: "date",
      eligible: (m, o, d) => {
        if (d > tolerance) return false;
        const a = normalizeRef(m.reference);
        const b = normalizeRef(o.reference);
        return a === null || b === null || a === b;
      },
    },
  ];

  for (const pass of passes) {
    const candidates: Candidate[] = [];
    mine.forEach((m, mi) => {
      if (usedMine.has(mi)) return;
      office.forEach((o, oi) => {
        if (usedOffice.has(oi)) return;
        const distance = dayDistance(m.date, o.date);
        if (pass.eligible(m, o, distance))
          candidates.push({ mi, oi, distance });
      });
    });
    candidates.sort(
      (a, b) => a.distance - b.distance || a.mi - b.mi || a.oi - b.oi,
    );
    for (const c of candidates) {
      if (usedMine.has(c.mi) || usedOffice.has(c.oi)) continue;
      usedMine.add(c.mi);
      usedOffice.add(c.oi);
      const m = mine[c.mi]!;
      const o = office[c.oi]!;
      pairs.push({
        mine: m,
        office: o,
        status: m.amount === o.amount ? "matched" : "amount_mismatch",
        difference: minor(m.amount - o.amount),
        reason: pass.reason,
      });
    }
  }

  return {
    pairs,
    mineOnly: mine.filter((_, i) => !usedMine.has(i)),
    officeOnly: office.filter((_, i) => !usedOffice.has(i)),
  };
}

export type BalanceOutcome = "due" | "refund" | "settled" | "unknown";

export interface TaxBalance {
  paidByMe: Minor;
  creditedByOffice: Minor;
  /** paidByMe - creditedByOffice; zero when both sides agree. */
  difference: Minor;
  assessedTotal: Minor | null;
  /**
   * What the tax office says is still open: assessed total minus what it counted.
   * Positive: amount due, negative: refund to expect. Null without an assessment.
   */
  remaining: Minor | null;
  /** The same figure by your own payments, for when the office's list is incomplete. */
  remainingByMe: Minor | null;
  outcome: BalanceOutcome;
  /** Absolute value of `remaining`. */
  amountDue: Minor;
  refundExpected: Minor;
}

const sum = (lines: readonly { amount: Minor }[]) =>
  minor(lines.reduce((s, l) => s + l.amount, 0));

export function computeBalance(
  mine: readonly { amount: Minor }[],
  office: readonly { amount: Minor }[],
  assessedTotal: Minor | null,
): TaxBalance {
  const paidByMe = sum(mine);
  const creditedByOffice = sum(office);
  const remaining =
    assessedTotal === null ? null : minor(assessedTotal - creditedByOffice);
  const remainingByMe =
    assessedTotal === null ? null : minor(assessedTotal - paidByMe);
  const outcome: BalanceOutcome =
    remaining === null
      ? "unknown"
      : remaining > 0
        ? "due"
        : remaining < 0
          ? "refund"
          : "settled";
  return {
    paidByMe,
    creditedByOffice,
    difference: minor(paidByMe - creditedByOffice),
    assessedTotal,
    remaining,
    remainingByMe,
    outcome,
    amountDue: minor(remaining !== null && remaining > 0 ? remaining : 0),
    refundExpected: minor(remaining !== null && remaining < 0 ? -remaining : 0),
  };
}
