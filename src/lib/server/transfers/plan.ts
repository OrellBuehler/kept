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
  archived: boolean;
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
  /** Ids of rows that already have a linked or dismissed transfers row. */
  taken: ReadonlySet<string>;
  /**
   * Ids of rows that wait for the amount of the other side (a `needs_amount`
   * row). They may still pair with a real counterpart that shows up later.
   */
  pending: ReadonlySet<string>;
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

/**
 * Whether a row on the other side of `source` can be its counterpart, apart
 * from the date. The amounts agree when the source's counter-amount (its own
 * or its original amount in the target's currency) equals the candidate's, or
 * when the candidate's original amount in the source's currency equals the
 * source's: whichever side carries the foreign amount, the pair is found.
 */
function counterpartMatches(
  source: PlanTransaction,
  sourceAccount: PlanAccount,
  target: PlanAccount,
  candidate: PlanTransaction,
): boolean {
  if (candidate.accountId !== target.id) return false;
  if (sign(candidate.amount) !== -sign(source.amount)) return false;
  const forward = counterAmount(source, target);
  const backward = counterAmount(candidate, sourceAccount);
  const agrees =
    (forward !== null && Math.abs(forward) === Math.abs(candidate.amount)) ||
    (backward !== null && Math.abs(backward) === Math.abs(source.amount));
  if (!agrees) return false;
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

/** Whether `iban` is absent or names `account`: a row that names someone else is a different payment. */
function namesOrSilent(iban: string | null, account: PlanAccount): boolean {
  return (
    iban === null ||
    (account.iban !== null && normalizeIban(iban) === account.iban)
  );
}

/**
 * Whether two booked rows on different accounts still look like the two sides
 * of one transfer, e.g. after one of them was edited: opposite signs, within
 * the window, agreeing amounts and no counterparty IBAN naming another account.
 * Rows in different currencies with no original amount cannot be compared and
 * count as agreeing.
 */
export function pairIsConsistent(
  a: PlanTransaction,
  aAccount: PlanAccount,
  b: PlanTransaction,
  bAccount: PlanAccount,
): boolean {
  if (aAccount.id === bAccount.id) return false;
  if (a.amount === 0 || sign(a.amount) !== -sign(b.amount)) return false;
  if (daysApart(a.bookingDate, b.bookingDate) > LINK_WINDOW_DAYS) return false;
  const forward = counterAmount(a, bAccount);
  const backward = counterAmount(b, aAccount);
  // A hand-resolved or taken-over foreign-currency pair carries no original
  // amount on either side: nothing to compare, so the other checks decide.
  const unknown =
    aAccount.currency !== bAccount.currency &&
    forward === null &&
    backward === null;
  const agrees =
    unknown ||
    (forward !== null && Math.abs(forward) === Math.abs(b.amount)) ||
    (backward !== null && Math.abs(backward) === Math.abs(a.amount));
  return (
    agrees &&
    namesOrSilent(a.counterpartyIban, bAccount) &&
    namesOrSilent(b.counterpartyIban, aAccount)
  );
}

/**
 * Whether a link the user made by hand can stand after an edit: the rows still
 * have opposite signs and neither names a different account of the user.
 */
export function manualLinkIsConsistent(
  a: PlanTransaction,
  aAccount: PlanAccount,
  b: PlanTransaction,
  bAccount: PlanAccount,
  accounts: readonly PlanAccount[],
): boolean {
  if (a.amount === 0 || sign(a.amount) !== -sign(b.amount)) return false;
  const byIban = accountsByIban(accounts);
  const fine = (iban: string | null, peer: PlanAccount) => {
    if (iban === null) return true;
    const owner = byIban.get(normalizeIban(iban));
    return owner === undefined || owner.id === peer.id;
  };
  return (
    fine(a.counterpartyIban, bAccount) && fine(b.counterpartyIban, aAccount)
  );
}

export function canMirrorOnto(
  target: PlanAccount,
  bookingDate: string,
): boolean {
  return (
    target.fillFromTransfers &&
    !target.archived &&
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

/** Candidates of one account by the absolute amounts they can be found under (booked and original). */
type CandidateIndex = Map<string, Map<number, PlanTransaction[]>>;

function indexCandidates(
  candidates: readonly PlanTransaction[],
): CandidateIndex {
  const index: CandidateIndex = new Map();
  for (const c of candidates) {
    if (c.source === "mirror") continue;
    let byAmount = index.get(c.accountId);
    if (!byAmount) {
      byAmount = new Map();
      index.set(c.accountId, byAmount);
    }
    const amounts = new Set([Math.abs(c.amount)]);
    if (c.originalAmount !== null && c.originalCurrency !== null) {
      amounts.add(Math.abs(c.originalAmount));
    }
    for (const amount of amounts) {
      const list = byAmount.get(amount);
      if (list) list.push(c);
      else byAmount.set(amount, [c]);
    }
  }
  return index;
}

function candidatesFor(
  index: CandidateIndex,
  source: PlanTransaction,
  targetId: string,
): PlanTransaction[] {
  const byAmount = index.get(targetId);
  if (!byAmount) return [];
  const found = new Map<string, PlanTransaction>();
  const amounts = new Set([Math.abs(source.amount)]);
  if (source.originalAmount !== null) {
    amounts.add(Math.abs(source.originalAmount));
  }
  for (const amount of amounts) {
    for (const c of byAmount.get(amount) ?? []) found.set(c.id, c);
  }
  return [...found.values()];
}

interface PairOption {
  source: PlanTransaction;
  candidate: PlanTransaction;
  distance: number;
}

/**
 * For every source row whose counterparty IBAN belongs to another account of
 * the user and that has no linked or dismissed transfers row yet:
 *  1. pair it with the unique closest opposite row on that account, or
 *  2. when that account is filled from transfers, mirror it there (or ask for
 *     the received amount when the currencies differ and none is known).
 * Pairs are assigned globally, closest dates first, so a row goes to the
 * source nearest to it. An ambiguous pair is skipped entirely so the user can
 * link it by hand; a row is never used twice. Rows in `pending` already wait
 * for an amount: they may pair, but are not asked about again.
 */
export function planLinks(input: PlanInput): PlannedLink[] {
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const byIban = accountsByIban(input.accounts);
  const used = new Set(input.taken);
  const index = indexCandidates(input.candidates);

  const sources = [...input.sources].sort(
    (a, b) =>
      a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id),
  );
  const order = new Map(sources.map((s, i) => [s.id, i]));
  const homes = new Map<string, PlanAccount>();
  const targets = new Map<string, PlanAccount>();
  const options: PairOption[] = [];
  const optionsOf = new Map<string, PairOption[]>();
  for (const source of sources) {
    if (source.source === "mirror" || used.has(source.id)) continue;
    if (source.amount === 0 || source.counterpartyIban === null) continue;
    const target = byIban.get(normalizeIban(source.counterpartyIban));
    const home = byId.get(source.accountId);
    if (!target || !home || target.id === home.id) continue;
    homes.set(source.id, home);
    targets.set(source.id, target);
    const own: PairOption[] = [];
    for (const c of candidatesFor(index, source, target.id)) {
      if (used.has(c.id) || !counterpartMatches(source, home, target, c)) {
        continue;
      }
      const distance = daysApart(source.bookingDate, c.bookingDate);
      if (distance > LINK_WINDOW_DAYS) continue;
      own.push({ source, candidate: c, distance });
    }
    optionsOf.set(source.id, own);
    options.push(...own);
  }

  options.sort(
    (a, b) =>
      a.distance - b.distance ||
      order.get(a.source.id)! - order.get(b.source.id)! ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
  const links = new Map<string, PlannedLink>();
  const skipped = new Set<string>();
  for (const o of options) {
    const { source, candidate } = o;
    if (skipped.has(source.id) || links.has(source.id)) continue;
    if (used.has(source.id) || used.has(candidate.id)) continue;
    const rival = optionsOf
      .get(source.id)!
      .some(
        (x) =>
          x.distance === o.distance &&
          x.candidate.id !== candidate.id &&
          !used.has(x.candidate.id),
      );
    if (rival) {
      skipped.add(source.id);
      continue;
    }
    used.add(source.id);
    used.add(candidate.id);
    links.set(source.id, {
      kind: "pair",
      sourceId: source.id,
      candidateId: candidate.id,
      ...sidesOf(
        source,
        candidate.id,
        homes.get(source.id)!.id,
        targets.get(source.id)!.id,
      ),
    });
  }

  const out: PlannedLink[] = [];
  for (const source of sources) {
    const pair = links.get(source.id);
    if (pair) {
      out.push(pair);
      continue;
    }
    const home = homes.get(source.id);
    const target = targets.get(source.id);
    if (!home || !target) continue;
    if (used.has(source.id) || skipped.has(source.id)) continue;
    if (!canMirrorOnto(target, source.bookingDate)) continue;
    const amount = counterAmount(source, target);
    used.add(source.id);
    if (amount === null) {
      if (input.pending.has(source.id)) continue;
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
  /** Copied from the source row. */
  reference: string | null;
  description: string | null;
}

export interface IncomingRow {
  key: string;
  bookingDate: string;
  amount: number;
  counterpartyIban: string | null;
  reference: string | null;
  description: string | null;
}

/** Words too common in transfer texts to tell two payments apart. */
const GENERIC_WORDS = new Set([
  "transfer",
  "payment",
  "zahlung",
  "ueberweisung",
  "überweisung",
  "gutschrift",
  "belastung",
  "dauerauftrag",
  "standing",
  "order",
  "from",
  "virement",
  "bonifico",
  "credit",
  "debit",
]);

function significantWords(text: string | null): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 4 || GENERIC_WORDS.has(word)) continue;
    if (/^\d+$/.test(word) && word.length < 6) continue;
    out.add(word);
  }
  return out;
}

const normalizeReference = (r: string | null): string =>
  (r ?? "").replace(/\s+/g, "").toUpperCase();

/** The row and the mirror carry the same reference or share a significant word. */
function sharesSignal(row: IncomingRow, mirror: MirrorRow): boolean {
  const reference = normalizeReference(row.reference);
  if (reference !== "" && reference === normalizeReference(mirror.reference)) {
    return true;
  }
  const words = significantWords(row.description);
  if (words.size === 0) return false;
  for (const word of significantWords(mirror.description)) {
    if (words.has(word)) return true;
  }
  return false;
}

/**
 * Which real rows take over which mirrors: same amount, within the window, and
 * a counterparty that is the mirror's source account. Only a row and mirror
 * that both name the same IBAN match outright. Any other row (no IBAN, or the
 * mirror has none) only counts when it is the single match for that mirror
 * (exact matches count as competition), and it carries the same reference or
 * shares a significant description word with it.
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
      pairs.push({
        row,
        mirror,
        distance,
        exact: mirrorIban !== null && rowIban === mirrorIban,
      });
    }
  }
  const perMirror = new Map<string, number>();
  const perRow = new Map<string, number>();
  for (const p of pairs) {
    perMirror.set(p.mirror.id, (perMirror.get(p.mirror.id) ?? 0) + 1);
    perRow.set(p.row.key, (perRow.get(p.row.key) ?? 0) + 1);
  }
  const eligible = pairs.filter(
    (p) =>
      p.exact ||
      (perMirror.get(p.mirror.id) === 1 &&
        perRow.get(p.row.key) === 1 &&
        sharesSignal(p.row, p.mirror)),
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
