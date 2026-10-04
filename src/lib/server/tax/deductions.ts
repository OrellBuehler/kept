import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { minor, type Minor } from "$lib/money";
import { DEDUCTION_TYPES, type DeductionType } from "$lib/tax-deductions";
import {
  categories,
  deductionMappings,
  getDB,
  transactions,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
import { listContributions } from "$lib/server/pillar3a/contributions";
import { idSchema } from "$lib/server/ledger/schemas";

export const deductionTypeSchema = z.enum(DEDUCTION_TYPES);

export const deductionMappingSchema = z.object({
  categoryId: idSchema,
  deductionType: z.union([deductionTypeSchema, z.literal("")]),
});

export const deductionExcludeSchema = z.object({
  transactionId: idSchema,
});

export interface DeductionMappingView {
  categoryId: string;
  name: string;
  parentId: string | null;
  /** Set on this category itself. */
  own: DeductionType | null;
  /** Own mapping, else the parent's. */
  effective: DeductionType | null;
  inherited: boolean;
}

export interface DeductionLine {
  /** Unique within a summary: `tx:<id>` for a transaction, `c:<id>` for a manual 3a contribution. */
  key: string;
  /** Null for a manual pillar 3a contribution, which has no transaction. */
  transactionId: string | null;
  /** Where the line comes from. */
  source: "category" | "pillar_3a";
  /** The account of the transaction; for a manual 3a contribution the pillar 3a account. */
  accountId: string;
  date: string;
  /** Counterparty, for display only. */
  label: string | null;
  /** Deductible amount: positive for money spent, negative for a refund. */
  amount: Minor;
  currency: string;
  /** Null for pillar 3a lines (they are not category-based). */
  categoryId: string | null;
  excluded: boolean;
  /** The year comes from the transaction's tax-year marking, not its booking date. */
  explicitYear: boolean;
}

export interface DeductionTotal {
  type: DeductionType;
  currency: string;
  total: Minor;
  lines: DeductionLine[];
}

export interface DeductionSummary {
  year: number;
  /** In fixed type order, then currency; only combinations with counted lines. */
  totals: DeductionTotal[];
  /** Lines left out of the totals, kept visible so they can be put back. */
  excluded: (DeductionLine & { type: DeductionType })[];
}

export function listDeductionMappings(userId: string): DeductionMappingView[] {
  const db = getDB();
  const cats = db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
    })
    .from(categories)
    .where(eq(categories.userId, userId))
    .orderBy(asc(categories.name))
    .all();
  const own = ownMappings(userId);
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  const ids = new Set(cats.map((c) => c.id));
  const top = cats
    .filter((c) => c.parentId === null || !ids.has(c.parentId))
    .sort(byName);
  const view = (c: (typeof cats)[number]): DeductionMappingView => {
    const mine = own.get(c.id) ?? null;
    const inherited = mine === null && c.parentId !== null;
    return {
      categoryId: c.id,
      name: c.name,
      parentId: c.parentId,
      own: mine,
      effective: mine ?? (c.parentId ? (own.get(c.parentId) ?? null) : null),
      inherited: inherited && own.has(c.parentId!),
    };
  };
  return top.flatMap((p) => [
    view(p),
    ...cats
      .filter((c) => c.parentId === p.id)
      .sort(byName)
      .map(view),
  ]);
}

function ownMappings(userId: string): Map<string, DeductionType> {
  return new Map(
    getDB()
      .select({
        categoryId: deductionMappings.categoryId,
        type: deductionMappings.deductionType,
      })
      .from(deductionMappings)
      .where(eq(deductionMappings.userId, userId))
      .all()
      .map((r) => [r.categoryId, r.type]),
  );
}

/** Sets (or, with null, clears) the deduction type of one of the user's categories. */
export function setCategoryDeduction(
  userId: string,
  categoryId: string,
  type: DeductionType | null,
): void {
  const db = getDB();
  const category = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, categoryId)))
    .get();
  if (!category) throw notFound("Category");
  if (type === null) {
    db.delete(deductionMappings)
      .where(
        and(
          eq(deductionMappings.userId, userId),
          eq(deductionMappings.categoryId, categoryId),
        ),
      )
      .run();
    return;
  }
  db.insert(deductionMappings)
    .values({ userId, categoryId, deductionType: type })
    .onConflictDoUpdate({
      target: [deductionMappings.userId, deductionMappings.categoryId],
      set: { deductionType: type, updatedAt: new Date() },
    })
    .run();
}

export function setTransactionDeductionExcluded(
  userId: string,
  transactionId: string,
  excluded: boolean,
): void {
  const updated = getDB()
    .update(transactions)
    .set({ deductionExcluded: excluded })
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, transactionId)),
    )
    .returning({ id: transactions.id })
    .all();
  if (updated.length === 0) throw notFound("Transaction");
}

/**
 * Deductions for one tax year: the user's mapped categories (subcategories
 * inherit their parent's mapping unless they have their own) summed per type
 * and currency. A transaction counts for its tax-year marking when it has
 * one, otherwise for the year of its booking date. Spending adds, refunds
 * reduce; no currency conversion.
 *
 * The `pillar_3a` type additionally contains the year's pillar 3a
 * contributions (detected payments and manual entries, ordinary and buy-in),
 * counted for the year of their credit date. A payment that already appears
 * as a category-mapped line is not counted twice.
 */
export function deductionSummary(
  userId: string,
  year: number,
): DeductionSummary {
  if (!Number.isInteger(year)) {
    throw new LedgerError("invalid", "Enter a valid year.", "year");
  }
  const own = ownMappings(userId);
  const groups = new Map<string, DeductionTotal>();
  const excluded: DeductionSummary["excluded"] = [];
  const seenTransactions = new Set<string>();
  const add = (type: DeductionType, line: DeductionLine) => {
    if (line.excluded) {
      excluded.push({ ...line, type });
      return;
    }
    const key = `${type}|${line.currency}`;
    let group = groups.get(key);
    if (!group) {
      group = { type, currency: line.currency, total: minor(0), lines: [] };
      groups.set(key, group);
    }
    group.total = minor(group.total + line.amount);
    group.lines.push(line);
  };

  if (own.size > 0) {
    const parents = new Map(
      getDB()
        .select({ id: categories.id, parentId: categories.parentId })
        .from(categories)
        .where(eq(categories.userId, userId))
        .all()
        .map((c) => [c.id, c.parentId]),
    );
    const typeOf = (categoryId: string): DeductionType | null => {
      const mine = own.get(categoryId);
      if (mine) return mine;
      const parent = parents.get(categoryId);
      return parent ? (own.get(parent) ?? null) : null;
    };

    const from = `${String(year).padStart(4, "0")}-01-01`;
    const to = `${String(year).padStart(4, "0")}-12-31`;
    const rows = getDB()
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        bookingDate: transactions.bookingDate,
        counterpartyName: transactions.counterpartyName,
        amount: transactions.amount,
        currency: transactions.currency,
        categoryId: transactions.categoryId,
        taxYear: transactions.taxYear,
        excluded: transactions.deductionExcluded,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          sql`${transactions.categoryId} is not null`,
          or(
            eq(transactions.taxYear, year),
            and(
              isNull(transactions.taxYear),
              sql`${transactions.bookingDate} >= ${from}`,
              sql`${transactions.bookingDate} <= ${to}`,
            ),
          ),
        ),
      )
      .orderBy(asc(transactions.bookingDate), asc(sql`"transactions"."rowid"`))
      .all();

    for (const r of rows) {
      const type = typeOf(r.categoryId!);
      if (!type) continue;
      seenTransactions.add(r.id);
      add(type, {
        key: `tx:${r.id}`,
        transactionId: r.id,
        source: "category",
        accountId: r.accountId,
        date: r.bookingDate,
        label: r.counterpartyName,
        amount: minor(-r.amount),
        currency: r.currency,
        categoryId: r.categoryId!,
        excluded: r.excluded,
        explicitYear: r.taxYear !== null,
      });
    }
  }

  const contributions = listContributions(userId, { year }).filter(
    (c) => c.transactionId === null || !seenTransactions.has(c.transactionId),
  );
  if (contributions.length > 0) {
    const flagged = new Set(
      getDB()
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.deductionExcluded, true),
            inArray(
              transactions.id,
              contributions.flatMap((c) =>
                c.transactionId === null ? [] : [c.transactionId],
              ),
            ),
          ),
        )
        .all()
        .map((r) => r.id),
    );
    for (const c of contributions) {
      add("pillar_3a", {
        key: c.key,
        transactionId: c.transactionId,
        source: "pillar_3a",
        accountId: c.paidFromAccountId ?? c.accountId,
        date: c.date,
        label: c.portfolioName,
        amount: c.amount,
        currency: PILLAR_3A_CURRENCY,
        categoryId: null,
        excluded: c.transactionId !== null && flagged.has(c.transactionId),
        explicitYear: false,
      });
    }
    for (const g of groups.values()) {
      if (g.type === "pillar_3a") {
        g.lines.sort((a, b) =>
          a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
        );
      }
    }
  }

  const order = (t: DeductionType) => DEDUCTION_TYPES.indexOf(t);
  const totals = [...groups.values()].sort(
    (a, b) =>
      order(a.type) - order(b.type) || a.currency.localeCompare(b.currency),
  );
  return { year, totals, excluded };
}
