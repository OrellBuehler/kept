import { normalizeIban } from "$lib/iban";
import type { AccountType } from "$lib/ledger-types";
import type { ReferenceType } from "$lib/references";

/**
 * Pure transfer linking: given rows to look at, the rows that could be their
 * counterpart and the user's accounts, decide which pairs to link and which
 * counter-transactions to create. No database access.
 */

/** A pair or mirror is looked for within this many days of the source's booking date. */
export const LINK_WINDOW_DAYS = 5;

export interface PlanAccount {
  id: string;
  name: string;
  currency: string;
  type: AccountType;
  /** Normalized; null when the account has no IBAN. */
  iban: string | null;
  openingDate: string | null;
  fillFromTransfers: boolean;
  hasPortfolios: boolean;
}

export interface PlanTransaction {
  id: string;
  accountId: string;
  source: "manual" | "import" | "mirror";
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  counterpartyIban: string | null;
  description: string | null;
  reference: string | null;
  referenceType: ReferenceType | null;
}

export interface PlannedMirror {
  accountId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  counterpartyName: string;
  counterpartyIban: string | null;
  description: string | null;
  reference: string | null;
  referenceType: ReferenceType | null;
}

interface Sides {
  /** The debited account's side. */
  outTransactionId: string | null;
  inTransactionId: string | null;
  fromAccountId: string;
  toAccountId: string;
}

export type PlannedLink =
  | ({ kind: "pair"; sourceId: string; candidateId: string } & Sides)
  | ({ kind: "mirror"; sourceId: string; mirror: PlannedMirror } & Sides)
  | ({ kind: "needs_amount"; sourceId: string } & Sides);

export interface PlanInput {
  /** Rows to look at, in any order. Mirrors and rows in `taken` are skipped. */
  sources: readonly PlanTransaction[];
  /** Rows that may be paired with a source (on any account). */
  candidates: readonly PlanTransaction[];
  accounts: readonly PlanAccount[];
  /** Ids of rows that already have a transfers row, whatever its status. */
  taken: ReadonlySet<string>;
}

export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d) / 86_400_000);
}

export const daysApart = (a: string, b: string): number =>
  Math.abs(dayNumber(a) - dayNumber(b));

export function shiftDate(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Account ids by normalized IBAN. Accounts without an IBAN are not addressable. */
export function accountsByIban(
  accounts: readonly PlanAccount[],
): Map<string, PlanAccount> {
  const out = new Map<string, PlanAccount>();
  for (const a of accounts) if (a.iban) out.set(a.iban, a);
  return out;
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/**
 * The amount the counter-side books, in `target`'s currency, with the sign of
 * the counter-side (opposite to the source). Null when it is unknown: the
 * accounts differ in currency and the statement carries no counter-amount.
 */
export function counterAmount(
  source: Pick<
    PlanTransaction,
    "amount" | "currency" | "originalAmount" | "originalCurrency"
  >,
  target: Pick<PlanAccount, "currency">,
): number | null {
  const direction = -sign(source.amount);
  if (direction === 0) return null;
  if (source.currency === target.currency) {
    return direction * Math.abs(source.amount);
  }
  if (
    source.originalCurrency === target.currency &&
    source.originalAmount !== null &&
    source.originalAmount !== 0
  ) {
    return direction * Math.abs(source.originalAmount);
  }
  return null;
}

/** Whether a row on the other side of `source` can be its counterpart, apart from the date. */
function counterpartMatches(
  source: PlanTransaction,
  sourceAccount: PlanAccount,
  target: PlanAccount,
  candidate: PlanTransaction,
): boolean {
  if (candidate.accountId !== target.id) return false;
  if (sign(candidate.amount) !== -sign(source.amount)) return false;
  const expected = counterAmount(source, target);
  if (expected === null || Math.abs(candidate.amount) !== Math.abs(expected)) {
    return false;
  }
  // A counterparty that names someone else is a different payment.
  if (
    candidate.counterpartyIban !== null &&
    sourceAccount.iban !== null &&
    normalizeIban(candidate.counterpartyIban) !== sourceAccount.iban
  ) {
    return false;
  }
  return true;
}

/** The unique closest candidate within the window, or null when there is none or it is ambiguous. */
function closestUnique(
  source: PlanTransaction,
  matches: readonly PlanTransaction[],
): PlanTransaction | null {
  let best: PlanTransaction | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const m of matches) {
    const d = daysApart(source.bookingDate, m.bookingDate);
    if (d > LINK_WINDOW_DAYS) continue;
    if (d < bestDistance) {
      best = m;
      bestDistance = d;
      tie = false;
    } else if (d === bestDistance) tie = true;
  }
  return tie ? null : best;
}

export function canMirrorOnto(
  target: PlanAccount,
  bookingDate: string,
): boolean {
  return (
    target.fillFromTransfers &&
    target.type !== "pillar_3a" &&
    !target.hasPortfolios &&
    (target.openingDate === null || bookingDate >= target.openingDate)
  );
}

function sidesOf(
  source: PlanTransaction,
  counterId: string | null,
  sourceAccountId: string,
  targetAccountId: string,
): Sides {
  const outgoing = source.amount < 0;
  return {
    outTransactionId: outgoing ? source.id : counterId,
    inTransactionId: outgoing ? counterId : source.id,
    fromAccountId: outgoing ? sourceAccountId : targetAccountId,
    toAccountId: outgoing ? targetAccountId : sourceAccountId,
  };
}

/**
 * For every source row whose counterparty IBAN belongs to another account of
 * the user and that has no transfers row yet:
 *  1. pair it with the unique closest opposite row on that account, or
 *  2. when that account is filled from transfers, mirror it there (or ask for
 *     the received amount when the currencies differ and none is known).
 * An ambiguous pair is skipped entirely so the user can link it by hand; a row
 * is never used twice.
 */
export function planLinks(input: PlanInput): PlannedLink[] {
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const byIban = accountsByIban(input.accounts);
  const used = new Set(input.taken);
  const candidatesByAccount = new Map<string, PlanTransaction[]>();
  for (const c of input.candidates) {
    if (c.source === "mirror") continue;
    const list = candidatesByAccount.get(c.accountId) ?? [];
    list.push(c);
    candidatesByAccount.set(c.accountId, list);
  }

  const sources = [...input.sources].sort(
    (a, b) =>
      a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id),
  );
  const out: PlannedLink[] = [];
  for (const source of sources) {
    if (source.source === "mirror" || used.has(source.id)) continue;
    if (source.amount === 0 || source.counterpartyIban === null) continue;
    const target = byIban.get(normalizeIban(source.counterpartyIban));
    const home = byId.get(source.accountId);
    if (!target || !home || target.id === home.id) continue;

    const matches = (candidatesByAccount.get(target.id) ?? []).filter(
      (c) => !used.has(c.id) && counterpartMatches(source, home, target, c),
    );
    const near = matches.filter(
      (c) => daysApart(source.bookingDate, c.bookingDate) <= LINK_WINDOW_DAYS,
    );
    if (near.length > 0) {
      const pick = closestUnique(source, near);
      if (pick) {
        used.add(source.id);
        used.add(pick.id);
        out.push({
          kind: "pair",
          sourceId: source.id,
          candidateId: pick.id,
          ...sidesOf(source, pick.id, home.id, target.id),
        });
      }
      continue;
    }

    if (!canMirrorOnto(target, source.bookingDate)) continue;
    const amount = counterAmount(source, target);
    used.add(source.id);
    if (amount === null) {
      out.push({
        kind: "needs_amount",
        sourceId: source.id,
        ...sidesOf(source, null, home.id, target.id),
      });
      continue;
    }
    out.push({
      kind: "mirror",
      sourceId: source.id,
      mirror: {
        accountId: target.id,
        bookingDate: source.bookingDate,
        valueDate: source.valueDate,
        amount,
        currency: target.currency,
        counterpartyName: home.name,
        counterpartyIban: home.iban,
        description: source.description,
        reference: source.reference,
        referenceType: source.referenceType,
      },
      ...sidesOf(source, null, home.id, target.id),
    });
  }
  return out;
}

export interface MirrorRow {
  id: string;
  bookingDate: string;
  amount: number;
  /** The IBAN of the account the mirror was created from. */
  counterpartyIban: string | null;
}

export interface IncomingRow {
  key: string;
  bookingDate: string;
  amount: number;
  counterpartyIban: string | null;
}

/**
 * Which real rows take over which mirrors: same amount, within the window, and
 * a counterparty that is the mirror's source account (a row without any
 * counterparty IBAN only counts when it is the single match for that mirror).
 * Closest dates are matched first; a mirror is used once. Returns row key -> mirror id.
 */
export function matchMirrors(
  rows: readonly IncomingRow[],
  mirrors: readonly MirrorRow[],
): Map<string, string> {
  interface Pair {
    row: IncomingRow;
    mirror: MirrorRow;
    distance: number;
    exact: boolean;
  }
  const pairs: Pair[] = [];
  for (const row of rows) {
    for (const mirror of mirrors) {
      if (row.amount !== mirror.amount) continue;
      const distance = daysApart(row.bookingDate, mirror.bookingDate);
      if (distance > LINK_WINDOW_DAYS) continue;
      const rowIban =
        row.counterpartyIban === null
          ? null
          : normalizeIban(row.counterpartyIban);
      const mirrorIban =
        mirror.counterpartyIban === null
          ? null
          : normalizeIban(mirror.counterpartyIban);
      if (rowIban !== null && mirrorIban !== null && rowIban !== mirrorIban) {
        continue;
      }
      pairs.push({ row, mirror, distance, exact: rowIban !== null });
    }
  }
  const blindPerMirror = new Map<string, number>();
  const blindPerRow = new Map<string, number>();
  for (const p of pairs) {
    if (p.exact) continue;
    blindPerMirror.set(p.mirror.id, (blindPerMirror.get(p.mirror.id) ?? 0) + 1);
    blindPerRow.set(p.row.key, (blindPerRow.get(p.row.key) ?? 0) + 1);
  }
  const eligible = pairs.filter(
    (p) =>
      p.exact ||
      (blindPerMirror.get(p.mirror.id) === 1 &&
        blindPerRow.get(p.row.key) === 1),
  );
  eligible.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.row.key.localeCompare(b.row.key) ||
      a.mirror.id.localeCompare(b.mirror.id),
  );
  const result = new Map<string, string>();
  const usedMirrors = new Set<string>();
  for (const p of eligible) {
    if (result.has(p.row.key) || usedMirrors.has(p.mirror.id)) continue;
    result.set(p.row.key, p.mirror.id);
    usedMirrors.add(p.mirror.id);
  }
  return result;
}
