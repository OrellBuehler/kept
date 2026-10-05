import { and, desc, eq, gt, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
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
  first,
  isUniqueViolationOn,
  type UniqueTarget,
  getDB,
  pillar3aBuyInYears,
  pillar3aContributions,
  portfolios,
  transactions,
  type DB,
  transaction,
} from "$lib/server/db";
import { localToday } from "$lib/server/ledger/balances";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { ledgerLock } from "$lib/server/ledger/lock";
import type {
  ContributionDetailsInput,
  ManualContributionInput,
} from "./schemas";
import { matchReferenceSql } from "./reference-match";
import { listYearSettingsInTx, type YearSettingView } from "./years";

type Reader = Pick<DB, "select">;

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

/**
 * An annotation whose payment is no longer detected: its reference changed, the
 * transaction became a mirror, a refund cancelled it, or the amount or currency
 * changed. It is not a contribution, but the gap years of a buy-in stay closed
 * until the user deletes it. (Deleting the transaction removes the annotation
 * with it, which cannot be told apart afterwards.)
 */
export interface OrphanAnnotation {
  id: string;
  transactionId: string;
  portfolioId: string;
  portfolioName: string;
  date: string;
  kind: Pillar3aContributionKind;
  gapYears: number[];
  note: string | null;
}

export type ContributionTarget = { id: string } | { transactionId: string };

export interface ContributionSaved {
  contribution: ContributionView;
  /** Non-blocking hints, e.g. an unpaid ordinary contribution next to a buy-in. */
  warnings: string[];
}

/** Whitespace-free, upper-case SQL form of `transactions.reference` (see `matchReference`). */
const normalizedReference = matchReferenceSql(transactions.reference);

function detectedQuery(conn: Reader, userId: string) {
  return conn
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
    .orderBy(desc(transactions.bookingDate), desc(transactions.id));
}

interface Credit {
  accountId: string;
  portfolioId: string;
  bookingDate: string;
  amount: Minor;
}

/**
 * Incoming CHF credits carrying a portfolio's deposit reference on an account
 * other than the portfolio's own: a refund or reversal of a payment. The 3a
 * account itself is skipped, since a deposit shows up there with the same
 * reference when its statements are imported.
 */
function creditsQuery(conn: Reader, userId: string) {
  return conn
    .select({
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
        ne(portfolios.accountId, transactions.accountId),
      ),
    )
    .where(
      and(
        eq(transactions.userId, userId),
        ne(transactions.source, "mirror"),
        isNotNull(transactions.reference),
        gt(transactions.amount, minor(0)),
        eq(transactions.currency, PILLAR_3A_CURRENCY),
      ),
    )
    .orderBy(transactions.bookingDate, transactions.id);
}

/**
 * Detected payments with their refunds taken off. A credit reduces the newest
 * payment of the same portfolio from the same account that is not newer than
 * the credit, then older ones; a fully refunded payment drops out, a credit
 * beyond what was paid is ignored.
 */
function toDetected(
  rows: readonly {
    transactionId: string;
    accountId: string;
    portfolioId: string;
    bookingDate: string;
    amount: Minor;
  }[],
  credits: readonly Credit[],
): DetectedContribution[] {
  const paid = rows.map((r) => ({ ...r, amount: minor(-r.amount) }));
  for (const credit of credits) {
    let left: number = credit.amount;
    const candidates = paid
      .filter(
        (p) =>
          p.portfolioId === credit.portfolioId &&
          p.accountId === credit.accountId &&
          p.bookingDate <= credit.bookingDate,
      )
      .sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1));
    for (const p of candidates) {
      if (left <= 0) break;
      const take = Math.min(left, p.amount);
      p.amount = minor(p.amount - take);
      left -= take;
    }
  }
  return paid.filter((p) => p.amount > 0);
}

/**
 * Outgoing CHF payments on any of the user's accounts whose reference equals
 * the deposit reference of one of the user's portfolios (open or closed),
 * net of refunds that carry the same reference back to the paying account.
 * Newest first.
 */
export async function detectedContributions(
  userId: string,
): Promise<DetectedContribution[]> {
  return await detectedContributionsInTx(getDB(), userId);
}

/** `detectedContributions` on a transaction you already hold. */
async function detectedContributionsInTx(
  tx: Reader,
  userId: string,
): Promise<DetectedContribution[]> {
  return toDetected(
    await detectedQuery(tx, userId),
    await creditsQuery(tx, userId),
  );
}

function loadAllQueries(conn: Reader, userId: string) {
  return {
    portfolios: conn
      .select({
        id: portfolios.id,
        name: portfolios.name,
        accountId: portfolios.accountId,
      })
      .from(portfolios)
      .where(eq(portfolios.userId, userId)),
    rows: conn
      .select()
      .from(pillar3aContributions)
      .where(eq(pillar3aContributions.userId, userId)),
    gaps: conn
      .select({
        contributionId: pillar3aBuyInYears.contributionId,
        year: pillar3aBuyInYears.year,
      })
      .from(pillar3aBuyInYears)
      .where(eq(pillar3aBuyInYears.userId, userId)),
  };
}

interface Loaded {
  views: ContributionView[];
  orphans: OrphanAnnotation[];
}

function assembleAll(
  portfolioList: readonly { id: string; name: string; accountId: string }[],
  rows: readonly (typeof pillar3aContributions.$inferSelect)[],
  gaps: readonly { contributionId: string; year: number }[],
  detected: readonly DetectedContribution[],
): Loaded {
  const portfolioRows = new Map(portfolioList.map((p) => [p.id, p]));
  const gapYearsOf = new Map<string, number[]>();
  for (const g of gaps) {
    const list = gapYearsOf.get(g.contributionId) ?? [];
    list.push(g.year);
    gapYearsOf.set(g.contributionId, list);
  }
  const live = new Set(detected.map((d) => d.transactionId));
  const orphans: OrphanAnnotation[] = [];
  for (const r of rows) {
    if (r.transactionId === null || live.has(r.transactionId)) continue;
    orphans.push({
      id: r.id,
      transactionId: r.transactionId,
      portfolioId: r.portfolioId,
      portfolioName: portfolioRows.get(r.portfolioId)?.name ?? "",
      date: r.date,
      kind: r.kind,
      gapYears:
        r.kind === "buy_in"
          ? (gapYearsOf.get(r.id) ?? []).sort((a, b) => a - b)
          : [],
      note: r.note,
    });
  }
  const annotations = new Map(
    rows
      .filter((r) => r.transactionId !== null)
      .map((r) => [r.transactionId!, r]),
  );

  const views: ContributionView[] = [];
  for (const d of detected) {
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
  views.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.key < b.key ? -1 : 1,
  );
  return { views, orphans };
}

async function loadAll(userId: string): Promise<Loaded> {
  return await loadAllInTx(getDB(), userId);
}

/** `loadAll` on a transaction you already hold. */
async function loadAllInTx(tx: Reader, userId: string): Promise<Loaded> {
  const q = loadAllQueries(tx, userId);
  return assembleAll(
    await q.portfolios,
    await q.rows,
    await q.gaps,
    await detectedContributionsInTx(tx, userId),
  );
}

/** Annotations whose payment is no longer detected; see `OrphanAnnotation`. */
export async function listOrphanAnnotations(
  userId: string,
): Promise<OrphanAnnotation[]> {
  return (await loadAll(userId)).orphans;
}

/**
 * Detected payments merged with their annotations and the manual entries,
 * newest credit date first, optionally of one tax year.
 */
export async function listContributions(
  userId: string,
  opts: { year?: number } = {},
): Promise<ContributionView[]> {
  const all = (await loadAll(userId)).views;
  return opts.year === undefined
    ? all
    : all.filter((c) => c.year === opts.year);
}

/**
 * Facts the pure rules need: every effective contribution, minus the one
 * named by `exceptKey`. Orphaned buy-ins keep their gap years closed.
 */
export function contributionFacts(
  views: readonly ContributionView[],
  exceptKey: string | null = null,
  orphans: readonly OrphanAnnotation[] = [],
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
  for (const o of orphans) {
    if (o.kind !== "buy_in") continue;
    for (const year of o.gapYears) buyInYears.push({ year, buyInId: o.id });
  }
  return { contributions, buyInYears };
}

function ageBenefitQuery(conn: Reader, userId: string) {
  return conn
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(
      and(eq(portfolios.userId, userId), eq(portfolios.closeReason, "age")),
    )
    .limit(1);
}

export async function ageBenefitDrawn(userId: string): Promise<boolean> {
  return (await first(ageBenefitQuery(getDB(), userId))) !== undefined;
}

/** `ageBenefitDrawn` on a transaction you already hold. */
async function ageBenefitDrawnInTx(
  tx: Reader,
  userId: string,
): Promise<boolean> {
  return (await first(ageBenefitQuery(tx, userId))) !== undefined;
}

interface BuyInFacts {
  views: readonly ContributionView[];
  orphans: readonly OrphanAnnotation[];
  settings: readonly YearSettingView[];
  ageBenefitDrawn: boolean;
}

/** The pure buy-in rules over facts the caller loaded. */
function evaluateBuyIn(
  facts: BuyInFacts,
  input: {
    key: string | null;
    contributionId: string | null;
    date: string;
    amount: Minor;
    gapYears: readonly number[];
  },
  today: string,
): BuyInCheck {
  const { settings } = facts;
  const contribution = contributionFacts(facts.views, input.key, facts.orphans);
  const gaps = gapsFor({ ...contribution, settings, today });
  const year = taxYearOf(input.date);
  const sumOf = (kind: Pillar3aContributionKind) =>
    contribution.contributions
      .filter((c) => c.year === year && c.kind === kind)
      .reduce((sum, c) => sum + c.amount, 0);
  return validateBuyIn({
    year,
    amount: input.amount,
    gapYears: input.gapYears,
    gaps,
    ageBenefitDrawn: facts.ageBenefitDrawn,
    ordinaryPaid: minor(sumOf("ordinary")),
    ordinaryLimit: yearLimit(year, settingFor(year, settings)).limit,
    otherBuyInsInYear: minor(sumOf("buy_in")),
    contributionId: input.contributionId,
    today,
  });
}

/** The errors of every saved buy-in under the rules as they stand now, by contribution key. */
function buyInErrors(facts: BuyInFacts, today: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const v of facts.views) {
    if (v.kind !== "buy_in") continue;
    const { errors } = evaluateBuyIn(
      facts,
      {
        key: v.key,
        contributionId: v.id,
        date: v.date,
        amount: v.amount,
        gapYears: v.gapYears,
      },
      today,
    );
    if (errors.length > 0) out.set(v.key, errors);
  }
  return out;
}

async function loadFacts(tx: Reader, userId: string): Promise<BuyInFacts> {
  const { views, orphans } = await loadAllInTx(tx, userId);
  return {
    views,
    orphans,
    settings: await listYearSettingsInTx(tx, userId),
    ageBenefitDrawn: await ageBenefitDrawnInTx(tx, userId),
  };
}

/**
 * A change may not break a buy-in that was fine before: adding or raising an
 * ordinary contribution in a closed gap year, or removing the ordinary
 * contribution that satisfied the full-payment precondition, would silently
 * invalidate it. Buy-ins that were already invalid do not block unrelated
 * changes. `exceptKey` is the contribution just saved, validated on its own.
 */
function assertNoNewBuyInErrors(
  before: ReadonlyMap<string, string[]>,
  after: ReadonlyMap<string, string[]>,
  exceptKey: string | null,
) {
  const broken: string[] = [];
  for (const [key, errors] of after) {
    if (key === exceptKey) continue;
    const had = new Set(before.get(key) ?? []);
    broken.push(...errors.filter((e) => !had.has(e)));
  }
  if (broken.length > 0) {
    throw new LedgerError(
      "invalid",
      `This change would invalidate a buy-in. ${[...new Set(broken)].join(" ")}`,
    );
  }
}

/**
 * Previews the buy-in rules for a contribution without saving. `key` names
 * the contribution being edited (see `ContributionView.key`), `null` for a new one.
 */
export async function checkBuyIn(
  userId: string,
  input: {
    key?: string | null;
    date: string;
    amount: Minor;
    gapYears: readonly number[];
  },
  today: string = localToday(),
): Promise<BuyInCheck> {
  const facts = await loadFacts(getDB(), userId);
  const own = input.key
    ? facts.views.find((v) => v.key === input.key)
    : undefined;
  return evaluateBuyIn(
    facts,
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

/**
 * The annotation of a detected payment is unique per transaction. Two
 * annotations of the same payment can both find no existing row and both
 * insert; the loser hits the unique index.
 */
const annotationUnique: UniqueTarget = {
  constraint: "pillar_3a_contributions_transaction_uq",
  table: "pillar_3a_contributions",
  columns: ["transaction_id"],
};

const buyInYearUnique: UniqueTarget = {
  constraint: "pillar_3a_buy_in_years_user_year_uq",
  table: "pillar_3a_buy_in_years",
  columns: ["user_id", "year"],
};

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

async function save(
  userId: string,
  spec: Spec,
  today: string,
): Promise<ContributionSaved> {
  let savedId = "";
  let warnings: string[] = [];
  try {
    await transaction(
      async (tx) => {
        const factsBefore = await loadFacts(tx, userId);
        const key = spec.transactionId
          ? `tx:${spec.transactionId}`
          : spec.existingId
            ? `c:${spec.existingId}`
            : null;
        const gapYears =
          spec.kind === "buy_in" ? [...new Set(spec.gapYears)] : [];
        if (spec.kind === "buy_in") {
          const check = evaluateBuyIn(
            factsBefore,
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
            throw new LedgerError(
              "invalid",
              check.errors.join(" "),
              "gapYears",
            );
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
          await tx
            .update(pillar3aContributions)
            .set(values)
            .where(
              and(
                eq(pillar3aContributions.userId, userId),
                eq(pillar3aContributions.id, spec.existingId),
              ),
            );
          savedId = spec.existingId;
        } else {
          savedId = (await first(
            tx
              .insert(pillar3aContributions)
              .values({ ...values, userId, transactionId: spec.transactionId })
              .returning({ id: pillar3aContributions.id }),
          ))!.id;
        }
        await tx
          .delete(pillar3aBuyInYears)
          .where(eq(pillar3aBuyInYears.contributionId, savedId));
        for (const year of gapYears) {
          await tx
            .insert(pillar3aBuyInYears)
            .values({ userId, contributionId: savedId, year });
        }
        assertNoNewBuyInErrors(
          buyInErrors(factsBefore, today),
          buyInErrors(await loadFacts(tx, userId), today),
          spec.transactionId ? `tx:${spec.transactionId}` : `c:${savedId}`,
        );
      },
      { lock: ledgerLock(userId) },
    );
  } catch (err) {
    if (isUniqueViolationOn(err, annotationUnique)) {
      throw new LedgerError(
        "conflict",
        "This payment was just saved from another request. Reload and try again.",
      );
    }
    if (isUniqueViolationOn(err, buyInYearUnique)) {
      throw new LedgerError(
        "conflict",
        "A gap year can only be closed by one buy-in.",
        "gapYears",
      );
    }
    throw err;
  }
  const contribution = (await loadAll(userId)).views.find(
    (c) => c.id === savedId,
  );
  if (!contribution) throw notFound("Contribution");
  return { contribution, warnings };
}

async function assertPortfolio(userId: string, portfolioId: string) {
  const found = await first(
    getDB()
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, portfolioId)))
      .limit(1),
  );
  if (!found) throw notFound("Portfolio");
}

/** A contribution the app cannot see as a payment, e.g. one paid from an account that is not tracked. */
export async function addManualContribution(
  userId: string,
  input: ManualContributionInput,
  today: string = localToday(),
): Promise<ContributionSaved> {
  await assertPortfolio(userId, input.portfolioId);
  return await save(
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

export async function updateManualContribution(
  userId: string,
  id: string,
  input: ManualContributionInput,
  today: string = localToday(),
): Promise<ContributionSaved> {
  const row = await first(
    getDB()
      .select({ id: pillar3aContributions.id })
      .from(pillar3aContributions)
      .where(
        and(
          eq(pillar3aContributions.userId, userId),
          eq(pillar3aContributions.id, id),
          isNull(pillar3aContributions.transactionId),
        ),
      )
      .limit(1),
  );
  if (!row) throw notFound("Contribution");
  await assertPortfolio(userId, input.portfolioId);
  return await save(
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
export async function updateDetectedContribution(
  userId: string,
  transactionId: string,
  input: ContributionDetailsInput,
  today: string = localToday(),
): Promise<ContributionSaved> {
  const detected = (await detectedContributions(userId)).find(
    (d) => d.transactionId === transactionId,
  );
  if (!detected) throw notFound("Contribution");
  const existing = await first(
    getDB()
      .select({ id: pillar3aContributions.id })
      .from(pillar3aContributions)
      .where(
        and(
          eq(pillar3aContributions.userId, userId),
          eq(pillar3aContributions.transactionId, transactionId),
        ),
      )
      .limit(1),
  );
  return await save(
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
 * Deletes a manual contribution, an annotation (which resets the payment to a
 * plain ordinary contribution) or an orphaned annotation. Gap years of a
 * buy-in are released. Refused when it would invalidate another buy-in, e.g.
 * by deleting the ordinary contribution that a buy-in year relies on.
 */
export async function deleteContribution(
  userId: string,
  target: ContributionTarget,
  today: string = localToday(),
): Promise<void> {
  await transaction(
    async (tx) => {
      const factsBefore = await loadFacts(tx, userId);
      const deleted = await tx
        .delete(pillar3aContributions)
        .where(
          and(
            eq(pillar3aContributions.userId, userId),
            "id" in target
              ? eq(pillar3aContributions.id, target.id)
              : eq(pillar3aContributions.transactionId, target.transactionId),
          ),
        )
        .returning({ id: pillar3aContributions.id });
      if (deleted.length === 0) throw notFound("Contribution");
      assertNoNewBuyInErrors(
        buyInErrors(factsBefore, today),
        buyInErrors(await loadFacts(tx, userId), today),
        null,
      );
    },
    { lock: ledgerLock(userId) },
  );
}
