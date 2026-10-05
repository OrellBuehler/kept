import { and, asc, between, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  billAllocations,
  bills,
  first,
  getDB,
  taxCredits,
  taxYears,
  transactions,
} from "$lib/server/db";
import { notFound } from "$lib/server/ledger/errors";
import { updateUnlessMirror } from "$lib/server/transfers/guard";
import {
  computeBalance,
  dayDistance,
  matchLines,
  type MatchOptions,
  type MineLine,
  type OfficeLine,
  type TaxBalance,
} from "./matching";
import type { TaxCreditInput, TaxYearInput } from "./schemas";

export interface TaxYearView {
  /** Null while the year only exists through tagged payments. */
  id: string | null;
  year: number;
  authority: string | null;
  currency: string;
  assessedTotal: Minor | null;
  notes: string | null;
}

/** A payment of yours that counts for the year. */
export interface PaymentLine extends MineLine {
  transactionId: string;
  accountId: string;
  currency: string;
  /** Counterparty or creditor name, for display only. */
  label: string | null;
  /** `tagged`: the transaction carries the year; `bill`: allocated to a bill that does. */
  via: "tagged" | "bill";
  billIds: string[];
}

export interface CreditLine extends OfficeLine {
  description: string | null;
}

export type RowKind =
  "matched" | "amount_mismatch" | "missing_office" | "missing_mine";

export interface ReconciliationRow {
  kind: RowKind;
  date: string;
  mine: PaymentLine | null;
  office: CreditLine | null;
  /** mine - office, with a missing side counting as zero. */
  difference: Minor;
}

export interface TaxSuggestion {
  creditId: string;
  transactionId: string;
  accountId: string;
  bookingDate: string;
  amount: Minor;
  label: string | null;
}

export interface Reconciliation {
  year: TaxYearView;
  rows: ReconciliationRow[];
  balance: TaxBalance;
  counts: Record<RowKind, number>;
  /** True when both sides have lines and every one is matched exactly. */
  reconciled: boolean;
  /** Tagged payments in another currency than the year's; they are not counted. */
  otherCurrencyLines: number;
  suggestions: TaxSuggestion[];
}

export interface TaxYearSummary {
  year: number;
  authority: string | null;
  currency: string;
  balance: TaxBalance;
  discrepancies: number;
  reconciled: boolean;
}

/** Wider than the matching tolerance: a hint, not a decision. */
const SUGGESTION_WINDOW_DAYS = 30;
const MAX_SUGGESTIONS_PER_LINE = 5;

function toYearView(row: typeof taxYears.$inferSelect): TaxYearView {
  return {
    id: row.id,
    year: row.year,
    authority: row.authority,
    currency: row.currency,
    assessedTotal: row.assessedTotal,
    notes: row.notes,
  };
}

async function yearRow(userId: string, year: number) {
  return await first(
    getDB()
      .select()
      .from(taxYears)
      .where(and(eq(taxYears.userId, userId), eq(taxYears.year, year)))
      .limit(1),
  );
}

/** Currency of the year's tagged payments or bills, when there is no row to say. */
async function inferCurrency(
  userId: string,
  year: number,
): Promise<string | null> {
  const db = getDB();
  const tx = await first(
    db
      .select({ currency: transactions.currency })
      .from(transactions)
      .where(
        and(eq(transactions.userId, userId), eq(transactions.taxYear, year)),
      )
      .orderBy(asc(transactions.bookingDate))
      .limit(1),
  );
  if (tx) return tx.currency;
  const bill = await first(
    db
      .select({ currency: bills.currency })
      .from(bills)
      .where(and(eq(bills.userId, userId), eq(bills.taxYear, year)))
      .orderBy(asc(bills.createdAt))
      .limit(1),
  );
  return bill?.currency ?? null;
}

async function yearView(
  userId: string,
  year: number,
): Promise<TaxYearView | null> {
  const row = await yearRow(userId, year);
  if (row) return toYearView(row);
  const currency = await inferCurrency(userId, year);
  if (currency === null) return null;
  return {
    id: null,
    year,
    authority: null,
    currency,
    assessedTotal: null,
    notes: null,
  };
}

export async function getTaxYear(
  userId: string,
  year: number,
): Promise<TaxYearView> {
  const view = await yearView(userId, year);
  if (!view) throw notFound("Tax year");
  return view;
}

export async function upsertTaxYear(
  userId: string,
  input: TaxYearInput,
): Promise<TaxYearView> {
  const values = {
    authority: input.authority,
    currency: input.currency,
    assessedTotal: input.assessedTotal,
    notes: input.notes,
  };
  // One statement: the unique index on (user, year) decides insert or update.
  await getDB()
    .insert(taxYears)
    .values({ ...values, userId, year: input.year })
    .onConflictDoUpdate({
      target: [taxYears.userId, taxYears.year],
      set: { ...values, updatedAt: new Date() },
    });
  return await getTaxYear(userId, input.year);
}

/** Removes the year's details and the office statement; tagged payments stay tagged. */
export async function deleteTaxYear(
  userId: string,
  year: number,
): Promise<void> {
  const row = await yearRow(userId, year);
  if (!row) throw notFound("Tax year");
  await getDB()
    .delete(taxYears)
    .where(and(eq(taxYears.userId, userId), eq(taxYears.id, row.id)));
}

async function ensureYearRow(userId: string, year: number) {
  const existing = await yearRow(userId, year);
  if (existing) return existing;
  const currency = await inferCurrency(userId, year);
  if (currency === null) throw notFound("Tax year");
  // A concurrent insert for the same year wins; either way the row is read back.
  await getDB()
    .insert(taxYears)
    .values({ userId, year, currency })
    .onConflictDoNothing({ target: [taxYears.userId, taxYears.year] });
  return (await yearRow(userId, year))!;
}

export async function addTaxCredit(
  userId: string,
  year: number,
  input: TaxCreditInput,
): Promise<CreditLine> {
  const row = await ensureYearRow(userId, year);
  const created = (
    await getDB()
      .insert(taxCredits)
      .values({ ...input, userId, taxYearId: row.id })
      .returning()
  )[0]!;
  return toCredit(created);
}

export async function deleteTaxCredit(
  userId: string,
  creditId: string,
): Promise<number> {
  const db = getDB();
  const credit = await first(
    db
      .select({ id: taxCredits.id, year: taxYears.year })
      .from(taxCredits)
      .innerJoin(taxYears, eq(taxYears.id, taxCredits.taxYearId))
      .where(and(eq(taxCredits.userId, userId), eq(taxCredits.id, creditId)))
      .limit(1),
  );
  if (!credit) throw notFound("Statement line");
  await db
    .delete(taxCredits)
    .where(and(eq(taxCredits.userId, userId), eq(taxCredits.id, creditId)));
  return credit.year;
}

/** Marks a transaction as a tax payment for `year`, or clears the mark with null. */
export async function setTransactionTaxYear(
  userId: string,
  transactionId: string,
  year: number | null,
): Promise<void> {
  await updateUnlessMirror(
    userId,
    transactionId,
    { taxYear: year },
    "tagged as a tax payment",
  );
}

function toCredit(row: typeof taxCredits.$inferSelect): CreditLine {
  return {
    id: row.id,
    date: row.bookingDate,
    amount: row.amount,
    reference: row.reference,
    description: row.description,
  };
}

async function creditLines(
  userId: string,
  yearId: string | null,
): Promise<CreditLine[]> {
  if (yearId === null) return [];
  return (
    await getDB()
      .select()
      .from(taxCredits)
      .where(
        and(eq(taxCredits.userId, userId), eq(taxCredits.taxYearId, yearId)),
      )
      .orderBy(
        asc(taxCredits.bookingDate),
        asc(taxCredits.seq),
        asc(taxCredits.id),
      )
  ).map(toCredit);
}

/**
 * Everything that counts as paid by you for the year, oldest first. A
 * transaction tagged with the year counts in full (its outflow). Otherwise
 * payments allocated to bills tagged with the year count by their allocated
 * amount. A transaction counts once; a tag on the transaction wins over bills,
 * and a transaction tagged with another year is never counted here.
 */
export async function paymentLines(
  userId: string,
  year: number,
): Promise<PaymentLine[]> {
  const db = getDB();
  const lines = new Map<string, PaymentLine>();

  const tagged = await db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), eq(transactions.taxYear, year)),
    );
  for (const t of tagged) {
    lines.set(t.id, {
      id: t.id,
      transactionId: t.id,
      accountId: t.accountId,
      currency: t.currency,
      date: t.bookingDate,
      amount: minor(-t.amount),
      reference: t.reference,
      label: t.counterpartyName,
      via: "tagged",
      billIds: [],
    });
  }

  const allocated = await db
    .select({
      allocation: billAllocations.amount,
      billId: bills.id,
      kind: bills.kind,
      creditor: bills.creditorName,
      transaction: transactions,
    })
    .from(billAllocations)
    .innerJoin(bills, eq(bills.id, billAllocations.billId))
    .innerJoin(transactions, eq(transactions.id, billAllocations.transactionId))
    .where(
      and(
        eq(billAllocations.userId, userId),
        eq(bills.userId, userId),
        eq(transactions.userId, userId),
        eq(bills.taxYear, year),
        isNull(transactions.taxYear),
      ),
    );
  for (const a of allocated) {
    const signed = a.kind === "credit_note" ? -a.allocation : a.allocation;
    const existing = lines.get(a.transaction.id);
    if (existing) {
      existing.amount = minor(existing.amount + signed);
      existing.billIds.push(a.billId);
      continue;
    }
    lines.set(a.transaction.id, {
      id: a.transaction.id,
      transactionId: a.transaction.id,
      accountId: a.transaction.accountId,
      currency: a.transaction.currency,
      date: a.transaction.bookingDate,
      amount: minor(signed),
      reference: a.transaction.reference,
      label: a.creditor ?? a.transaction.counterpartyName,
      via: "bill",
      billIds: [a.billId],
    });
  }

  return [...lines.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
}

async function suggestionsFor(
  userId: string,
  officeOnly: readonly CreditLine[],
  counted: ReadonlySet<string>,
  currency: string,
): Promise<TaxSuggestion[]> {
  const out: TaxSuggestion[] = [];
  const db = getDB();
  for (const credit of officeOnly) {
    const from = shiftDate(credit.date, -SUGGESTION_WINDOW_DAYS);
    const to = shiftDate(credit.date, SUGGESTION_WINDOW_DAYS);
    const rows = (
      await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            ne(transactions.source, "mirror"),
            isNull(transactions.taxYear),
            eq(transactions.currency, currency),
            eq(transactions.amount, minor(-credit.amount)),
            between(transactions.bookingDate, from, to),
          ),
        )
    )
      .filter((t) => !counted.has(t.id))
      .sort(
        (a, b) =>
          dayDistance(a.bookingDate, credit.date) -
            dayDistance(b.bookingDate, credit.date) || a.id.localeCompare(b.id),
      )
      .slice(0, MAX_SUGGESTIONS_PER_LINE);
    for (const t of rows) {
      out.push({
        creditId: credit.id,
        transactionId: t.id,
        accountId: t.accountId,
        bookingDate: t.bookingDate,
        amount: t.amount,
        label: t.counterpartyName,
      });
    }
  }
  return out;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const kindOrder: Record<RowKind, number> = {
  amount_mismatch: 0,
  missing_office: 1,
  missing_mine: 2,
  matched: 3,
};

/** Reconciles one tax year; null when the year has neither details nor tagged payments. */
export async function reconcileYear(
  userId: string,
  year: number,
  opts: MatchOptions = {},
): Promise<Reconciliation | null> {
  const view = await yearView(userId, year);
  if (!view) return null;

  const all = await paymentLines(userId, year);
  const mine = all.filter((l) => l.currency === view.currency);
  const office = await creditLines(userId, view.id);
  const matching = matchLines(mine, office, opts);

  const rows: ReconciliationRow[] = [
    ...matching.pairs.map((p): ReconciliationRow => ({
      kind: p.status,
      date: p.mine.date < p.office.date ? p.mine.date : p.office.date,
      mine: p.mine,
      office: p.office,
      difference: p.difference,
    })),
    ...matching.mineOnly.map((m): ReconciliationRow => ({
      kind: "missing_office",
      date: m.date,
      mine: m,
      office: null,
      difference: m.amount,
    })),
    ...matching.officeOnly.map((o): ReconciliationRow => ({
      kind: "missing_mine",
      date: o.date,
      mine: null,
      office: o,
      difference: minor(-o.amount),
    })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || kindOrder[a.kind] - kindOrder[b.kind],
  );

  const counts: Record<RowKind, number> = {
    matched: 0,
    amount_mismatch: 0,
    missing_office: 0,
    missing_mine: 0,
  };
  for (const r of rows) counts[r.kind]++;

  return {
    year: view,
    rows,
    balance: computeBalance(mine, office, view.assessedTotal),
    counts,
    reconciled:
      rows.length > 0 &&
      counts.amount_mismatch + counts.missing_office + counts.missing_mine ===
        0,
    otherCurrencyLines: all.length - mine.length,
    suggestions: await suggestionsFor(
      userId,
      matching.officeOnly,
      new Set(all.map((l) => l.transactionId)),
      view.currency,
    ),
  };
}

/** Every year with a details row or tagged payments/bills, newest first. */
export async function listTaxYears(userId: string): Promise<TaxYearSummary[]> {
  const db = getDB();
  const years = new Set<number>();
  for (const r of await db
    .select({ year: taxYears.year })
    .from(taxYears)
    .where(eq(taxYears.userId, userId))) {
    years.add(r.year);
  }
  for (const r of await db
    .selectDistinct({ year: transactions.taxYear })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), isNotNull(transactions.taxYear)),
    )) {
    if (r.year !== null) years.add(r.year);
  }
  for (const r of await db
    .selectDistinct({ year: bills.taxYear })
    .from(bills)
    .where(and(eq(bills.userId, userId), isNotNull(bills.taxYear)))) {
    if (r.year !== null) years.add(r.year);
  }

  const out: TaxYearSummary[] = [];
  for (const year of [...years].sort((a, b) => b - a)) {
    const rec = await reconcileYear(userId, year);
    if (!rec) continue;
    const discrepancies =
      rec.counts.amount_mismatch +
      rec.counts.missing_office +
      rec.counts.missing_mine;
    out.push({
      year,
      authority: rec.year.authority,
      currency: rec.year.currency,
      balance: rec.balance,
      discrepancies,
      reconciled: rec.reconciled,
    });
  }
  return out;
}
