import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  gapsFor,
  lateDecemberWarning,
  PILLAR_3A_CURRENCY,
  settingFor,
  taxYearOf,
  validateBuyIn,
  yearLimit,
  type BuyInCheck,
  type BuyInYearFact,
  type ContributionFact,
} from "$lib/pillar-3a";
import type { Pillar3aContributionKind } from "$lib/pillar-3a-types";
import {
  getDB,
  pillar3aBuyInYears,
  pillar3aContributions,
  portfolios,
  transactions,
} from "$lib/server/db";
import { localToday } from "$lib/server/ledger/balances";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type {
  ContributionDetailsInput,
  ManualContributionInput,
} from "./schemas";
import { matchReferenceSql } from "./reference-match";
import { listYearSettings } from "./years";

export interface DetectedContribution {
  transactionId: string;
  /** The account the payment was made from. */
  accountId: string;
  portfolioId: string;
  bookingDate: string;
  /** Positive CHF amount paid. */
  amount: Minor;
}

export interface ContributionView {
  /** Stable key: `tx:<transactionId>` for detected payments, else `c:<id>`. */
  key: string;
  /** The contribution row (a manual entry or an annotation); null for a plain detected payment. */
  id: string | null;
  transactionId: string | null;
  source: "detected" | "manual";
  portfolioId: string;
  portfolioName: string;
  /** The pillar 3a account of the portfolio. */
  accountId: string;
  /** The account a detected payment was made from. */
  paidFromAccountId: string | null;
  /** Booking date of the detected payment. */
  bookingDate: string | null;
  /** Credit date: it sets the tax year. */
  date: string;
  /** Tax year: the year of `date`. */
  year: number;
  amount: Minor;
  kind: Pillar3aContributionKind;
  /** Gap years a buy-in closes. */
  gapYears: number[];
  note: string | null;
  /** The credit date was set by hand rather than taken from the booking date. */
  dateOverridden: boolean;
  /** A detected payment booked late in December that may be credited in January. */
  lateDecemberWarning: string | null;
}

export type ContributionTarget = { id: string } | { transactionId: string };

export interface ContributionSaved {
  contribution: ContributionView;
  /** Non-blocking hints, e.g. an unpaid ordinary contribution next to a buy-in. */
  warnings: string[];
}

/** Whitespace-free, upper-case SQL form of `transactions.reference` (see `matchReference`). */
const normalizedReference = matchReferenceSql(transactions.reference);

/**
 * Outgoing CHF payments on any of the user's accounts whose reference equals
 * the deposit reference of one of the user's portfolios (open or closed).
 * One query joining transactions to portfolios; newest first.
 */
export function detectedContributions(userId: string): DetectedContribution[] {
  return getDB()
    .select({
      transactionId: transactions.id,
      accountId: transactions.accountId,
      portfolioId: portfolios.id,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
    })
    .from(transactions)
    .innerJoin(
      portfolios,
      and(
        eq(portfolios.userId, userId),
        sql`${portfolios.depositReference} = ${normalizedReference}`,
      ),
    )
    .where(
      and(
        eq(transactions.userId, userId),
        // Only the paying side; a mirror copies its source's reference.
        ne(transactions.source, "mirror"),
        isNotNull(transactions.reference),
        lt(transactions.amount, minor(0)),
        eq(transactions.currency, PILLAR_3A_CURRENCY),
      ),
    )
    .orderBy(desc(transactions.bookingDate), desc(transactions.id))
    .all()
    .map((r) => ({ ...r, amount: minor(-r.amount) }));
}

function loadAll(userId: string): ContributionView[] {
  const db = getDB();
  const portfolioRows = new Map(
    db
      .select({
        id: portfolios.id,
        name: portfolios.name,
        accountId: portfolios.accountId,
      })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .all()
      .map((p) => [p.id, p]),
  );
  const rows = db
    .select()
    .from(pillar3aContributions)
    .where(eq(pillar3aContributions.userId, userId))
    .all();
  const gapYearsOf = new Map<string, number[]>();
  for (const g of db
    .select({
      contributionId: pillar3aBuyInYears.contributionId,
      year: pillar3aBuyInYears.year,
    })
    .from(pillar3aBuyInYears)
    .where(eq(pillar3aBuyInYears.userId, userId))
    .all()) {
    const list = gapYearsOf.get(g.contributionId) ?? [];
    list.push(g.year);
    gapYearsOf.set(g.contributionId, list);
  }
  const annotations = new Map(
    rows
      .filter((r) => r.transactionId !== null)
      .map((r) => [r.transactionId!, r]),
  );

  const views: ContributionView[] = [];
  for (const d of detectedContributions(userId)) {
    const portfolio = portfolioRows.get(d.portfolioId)!;
    const a = annotations.get(d.transactionId) ?? null;
    const date = a?.date ?? d.bookingDate;
    const kind = a?.kind ?? "ordinary";
    views.push({
      key: `tx:${d.transactionId}`,
      id: a?.id ?? null,
      transactionId: d.transactionId,
      source: "detected",
      portfolioId: portfolio.id,
      portfolioName: portfolio.name,
      accountId: portfolio.accountId,
      paidFromAccountId: d.accountId,
      bookingDate: d.bookingDate,
      date,
      year: taxYearOf(date),
      amount: d.amount,
      kind,
      gapYears:
        a && kind === "buy_in"
          ? (gapYearsOf.get(a.id) ?? []).sort((a, b) => a - b)
          : [],
      note: a?.note ?? null,
      dateOverridden: a !== null && a.date !== d.bookingDate,
      lateDecemberWarning:
        a !== null && a.date !== d.bookingDate
          ? null
          : lateDecemberWarning(d.bookingDate),
    });
  }
  for (const r of rows) {
    if (r.transactionId !== null) continue;
    const portfolio = portfolioRows.get(r.portfolioId);
    if (!portfolio) continue;
    views.push({
      key: `c:${r.id}`,
      id: r.id,
      transactionId: null,
      source: "manual",
      portfolioId: portfolio.id,
      portfolioName: portfolio.name,
      accountId: portfolio.accountId,
      paidFromAccountId: null,
      bookingDate: null,
      date: r.date,
      year: taxYearOf(r.date),
      amount: r.amount,
      kind: r.kind,
      gapYears:
        r.kind === "buy_in"
          ? (gapYearsOf.get(r.id) ?? []).sort((a, b) => a - b)
          : [],
      note: r.note,
      dateOverridden: false,
      lateDecemberWarning: null,
    });
  }
  return views.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.key < b.key ? -1 : 1,
  );
}

/**
 * Detected payments merged with their annotations and the manual entries,
 * newest credit date first, optionally of one tax year.
 */
export function listContributions(
  userId: string,
  opts: { year?: number } = {},
): ContributionView[] {
  const all = loadAll(userId);
  return opts.year === undefined
    ? all
    : all.filter((c) => c.year === opts.year);
}

/** Facts the pure rules need: every effective contribution, minus the one named by `exceptKey`. */
export function contributionFacts(
  views: readonly ContributionView[],
  exceptKey: string | null = null,
): { contributions: ContributionFact[]; buyInYears: BuyInYearFact[] } {
  const contributions: ContributionFact[] = [];
  const buyInYears: BuyInYearFact[] = [];
  for (const c of views) {
    if (c.key === exceptKey) continue;
    contributions.push({ year: c.year, kind: c.kind, amount: c.amount });
    if (c.kind === "buy_in" && c.id !== null) {
      for (const year of c.gapYears) buyInYears.push({ year, buyInId: c.id });
    }
  }
  return { contributions, buyInYears };
}

export function ageBenefitDrawn(userId: string): boolean {
  return (
    getDB()
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(
        and(eq(portfolios.userId, userId), eq(portfolios.closeReason, "age")),
      )
      .get() !== undefined
  );
}

function evaluateBuyIn(
  userId: string,
  views: readonly ContributionView[],
  input: {
    key: string | null;
    contributionId: string | null;
    date: string;
    amount: Minor;
    gapYears: readonly number[];
  },
  today: string,
): BuyInCheck {
  const settings = listYearSettings(userId);
  const facts = contributionFacts(views, input.key);
  const gaps = gapsFor({ ...facts, settings, today });
  const year = taxYearOf(input.date);
  const ordinaryPaid = facts.contributions
    .filter((c) => c.year === year && c.kind === "ordinary")
    .reduce((sum, c) => sum + c.amount, 0);
  return validateBuyIn({
    year,
    amount: input.amount,
    gapYears: input.gapYears,
    gaps,
    ageBenefitDrawn: ageBenefitDrawn(userId),
    ordinaryPaid: minor(ordinaryPaid),
    ordinaryLimit: yearLimit(year, settingFor(year, settings)).limit,
    contributionId: input.contributionId,
  });
}

/**
 * Previews the buy-in rules for a contribution without saving. `key` names
 * the contribution being edited (see `ContributionView.key`), `null` for a new one.
 */
export function checkBuyIn(
  userId: string,
  input: {
    key?: string | null;
    date: string;
    amount: Minor;
    gapYears: readonly number[];
  },
  today: string = localToday(),
): BuyInCheck {
  const views = loadAll(userId);
  const own = input.key ? views.find((v) => v.key === input.key) : undefined;
  return evaluateBuyIn(
    userId,
    views,
    {
      key: input.key ?? null,
      contributionId: own?.id ?? null,
      date: input.date,
      amount: input.amount,
      gapYears: input.gapYears,
    },
    today,
  );
}

/** Annotation rows whose payment no longer matches a portfolio reference are dead weight; drop them. */
function pruneOrphanAnnotations(userId: string) {
  const live = new Set(
    detectedContributions(userId).map((d) => d.transactionId),
  );
  const db = getDB();
  const orphans = db
    .select({
      id: pillar3aContributions.id,
      transactionId: pillar3aContributions.transactionId,
    })
    .from(pillar3aContributions)
    .where(
      and(
        eq(pillar3aContributions.userId, userId),
        isNotNull(pillar3aContributions.transactionId),
      ),
    )
    .all()
    .filter((r) => !live.has(r.transactionId!))
    .map((r) => r.id);
  if (orphans.length > 0) {
    db.delete(pillar3aContributions)
      .where(inArray(pillar3aContributions.id, orphans))
      .run();
  }
}

function isBuyInYearConflict(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed: pillar_3a_buy_in_years/.test(e.message)) {
      return true;
    }
  }
  return false;
}

interface Spec {
  existingId: string | null;
  transactionId: string | null;
  portfolioId: string;
  date: string;
  amount: Minor;
  kind: Pillar3aContributionKind;
  gapYears: number[];
  note: string | null;
}

function save(userId: string, spec: Spec, today: string): ContributionSaved {
  const db = getDB();
  let savedId = "";
  let warnings: string[] = [];
  try {
    db.transaction((tx) => {
      pruneOrphanAnnotations(userId);
      const key = spec.transactionId
        ? `tx:${spec.transactionId}`
        : spec.existingId
          ? `c:${spec.existingId}`
          : null;
      const gapYears =
        spec.kind === "buy_in" ? [...new Set(spec.gapYears)] : [];
      if (spec.kind === "buy_in") {
        const check = evaluateBuyIn(
          userId,
          loadAll(userId),
          {
            key,
            contributionId: spec.existingId,
            date: spec.date,
            amount: spec.amount,
            gapYears,
          },
          today,
        );
        if (check.errors.length > 0) {
          throw new LedgerError("invalid", check.errors.join(" "), "gapYears");
        }
        warnings = check.warnings;
      }
      const values = {
        portfolioId: spec.portfolioId,
        date: spec.date,
        amount: spec.amount,
        kind: spec.kind,
        note: spec.note,
      };
      if (spec.existingId) {
        tx.update(pillar3aContributions)
          .set(values)
          .where(
            and(
              eq(pillar3aContributions.userId, userId),
              eq(pillar3aContributions.id, spec.existingId),
            ),
          )
          .run();
        savedId = spec.existingId;
      } else {
        savedId = tx
          .insert(pillar3aContributions)
          .values({ ...values, userId, transactionId: spec.transactionId })
          .returning({ id: pillar3aContributions.id })
          .get().id;
      }
      tx.delete(pillar3aBuyInYears)
        .where(eq(pillar3aBuyInYears.contributionId, savedId))
        .run();
      for (const year of gapYears) {
        tx.insert(pillar3aBuyInYears)
          .values({ userId, contributionId: savedId, year })
          .run();
      }
    });
  } catch (err) {
    if (isBuyInYearConflict(err)) {
      throw new LedgerError(
        "conflict",
        "A gap year can only be closed by one buy-in.",
        "gapYears",
      );
    }
    throw err;
  }
  const contribution = loadAll(userId).find((c) => c.id === savedId);
  if (!contribution) throw notFound("Contribution");
  return { contribution, warnings };
}

function assertPortfolio(userId: string, portfolioId: string) {
  const found = getDB()
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, portfolioId)))
    .get();
  if (!found) throw notFound("Portfolio");
}

/** A contribution the app cannot see as a payment, e.g. one paid from an account that is not tracked. */
export function addManualContribution(
  userId: string,
  input: ManualContributionInput,
  today: string = localToday(),
): ContributionSaved {
  assertPortfolio(userId, input.portfolioId);
  return save(
    userId,
    {
      existingId: null,
      transactionId: null,
      portfolioId: input.portfolioId,
      date: input.date,
      amount: input.amount,
      kind: input.kind,
      gapYears: input.gapYears,
      note: input.note,
    },
    today,
  );
}

export function updateManualContribution(
  userId: string,
  id: string,
  input: ManualContributionInput,
  today: string = localToday(),
): ContributionSaved {
  const row = getDB()
    .select({ id: pillar3aContributions.id })
    .from(pillar3aContributions)
    .where(
      and(
        eq(pillar3aContributions.userId, userId),
        eq(pillar3aContributions.id, id),
        isNull(pillar3aContributions.transactionId),
      ),
    )
    .get();
  if (!row) throw notFound("Contribution");
  assertPortfolio(userId, input.portfolioId);
  return save(
    userId,
    {
      existingId: id,
      transactionId: null,
      portfolioId: input.portfolioId,
      date: input.date,
      amount: input.amount,
      kind: input.kind,
      gapYears: input.gapYears,
      note: input.note,
    },
    today,
  );
}

/**
 * Annotates a detected payment: kind, credit date, gap years and note. The
 * amount always comes from the transaction.
 */
export function updateDetectedContribution(
  userId: string,
  transactionId: string,
  input: ContributionDetailsInput,
  today: string = localToday(),
): ContributionSaved {
  const detected = detectedContributions(userId).find(
    (d) => d.transactionId === transactionId,
  );
  if (!detected) throw notFound("Contribution");
  const existing = getDB()
    .select({ id: pillar3aContributions.id })
    .from(pillar3aContributions)
    .where(
      and(
        eq(pillar3aContributions.userId, userId),
        eq(pillar3aContributions.transactionId, transactionId),
      ),
    )
    .get();
  return save(
    userId,
    {
      existingId: existing?.id ?? null,
      transactionId,
      portfolioId: detected.portfolioId,
      date: input.date,
      amount: detected.amount,
      kind: input.kind,
      gapYears: input.gapYears,
      note: input.note,
    },
    today,
  );
}

/**
 * Deletes a manual contribution, or an annotation (which resets the payment to
 * a plain ordinary contribution). Gap years of a buy-in are released.
 */
export function deleteContribution(
  userId: string,
  target: ContributionTarget,
): void {
  const deleted = getDB()
    .delete(pillar3aContributions)
    .where(
      and(
        eq(pillar3aContributions.userId, userId),
        "id" in target
          ? eq(pillar3aContributions.id, target.id)
          : eq(pillar3aContributions.transactionId, target.transactionId),
      ),
    )
    .returning({ id: pillar3aContributions.id })
    .all();
  if (deleted.length === 0) throw notFound("Contribution");
}
