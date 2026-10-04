import { and, count, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { minor, shareOf, type Minor, type ShareBasis } from "$lib/money";
import {
  accounts,
  budgets,
  categories,
  getDB,
  transactions,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { monthBounds } from "$lib/server/dashboard/dates";
import { notInLinkedTransfer } from "$lib/server/transfers/exclusion";
import { getCategory } from "./categories";
import type { BudgetInput } from "./schemas";

export interface BudgetView {
  id: string;
  categoryId: string;
  currency: string;
  amount: Minor;
}

const columns = {
  id: budgets.id,
  categoryId: budgets.categoryId,
  currency: budgets.currency,
  amount: budgets.amount,
};

export function listBudgets(userId: string): BudgetView[] {
  return getDB()
    .select(columns)
    .from(budgets)
    .where(eq(budgets.userId, userId))
    .all();
}

function getBudget(userId: string, id: string): BudgetView {
  const row = getDB()
    .select(columns)
    .from(budgets)
    .where(and(eq(budgets.userId, userId), eq(budgets.id, id)))
    .get();
  if (!row) throw notFound("Budget");
  return row;
}

function assertBudgetable(userId: string, categoryId: string) {
  let category;
  try {
    category = getCategory(userId, categoryId);
  } catch (err) {
    if (err instanceof LedgerError && err.code === "not_found") {
      throw new LedgerError("invalid", "Choose a category.", "categoryId");
    }
    throw err;
  }
  if (category.kind !== "expense") {
    throw new LedgerError(
      "invalid",
      "Budgets are for expense categories.",
      "categoryId",
    );
  }
}

function assertUnique(userId: string, input: BudgetInput, exceptId?: string) {
  const clash = listBudgets(userId).find(
    (b) =>
      b.id !== exceptId &&
      b.categoryId === input.categoryId &&
      b.currency === input.currency,
  );
  if (clash) {
    throw new LedgerError(
      "conflict",
      "This category already has a budget in this currency.",
      "categoryId",
    );
  }
}

export function createBudget(userId: string, input: BudgetInput): BudgetView {
  assertBudgetable(userId, input.categoryId);
  assertUnique(userId, input);
  return getDB()
    .insert(budgets)
    .values({ userId, ...input })
    .returning(columns)
    .get();
}

export function updateBudget(
  userId: string,
  id: string,
  input: BudgetInput,
): BudgetView {
  getBudget(userId, id);
  assertBudgetable(userId, input.categoryId);
  assertUnique(userId, input, id);
  getDB()
    .update(budgets)
    .set(input)
    .where(and(eq(budgets.userId, userId), eq(budgets.id, id)))
    .run();
  return getBudget(userId, id);
}

export function deleteBudget(userId: string, id: string): void {
  getBudget(userId, id);
  getDB()
    .delete(budgets)
    .where(and(eq(budgets.userId, userId), eq(budgets.id, id)))
    .run();
}

interface OwnSpend {
  categoryId: string;
  parentId: string | null;
  currency: string;
  /** Net spending: refunds in the category reduce it. */
  spent: number;
}

/**
 * Spending booked directly on each expense category in a "YYYY-MM" month.
 * Rows in a linked transfer between the user's own accounts do not count.
 * With basis "share" every transaction is scaled by the ownership share of
 * its account (rounded per transaction, see `shareOf`); stored amounts stay
 * at 100%.
 */
function ownSpend(
  userId: string,
  month: string,
  basis: ShareBasis,
): OwnSpend[] {
  const { first, last } = monthBounds(month);
  const where = and(
    eq(transactions.userId, userId),
    eq(categories.userId, userId),
    eq(categories.kind, "expense"),
    gte(transactions.bookingDate, first),
    lte(transactions.bookingDate, last),
    notInLinkedTransfer,
  );
  const db = getDB();
  if (basis === "total") {
    return db
      .select({
        categoryId: transactions.categoryId,
        parentId: categories.parentId,
        currency: transactions.currency,
        total: sql<number>`sum(${transactions.amount})`,
      })
      .from(transactions)
      .innerJoin(categories, eq(categories.id, transactions.categoryId))
      .where(where)
      .groupBy(transactions.categoryId, transactions.currency)
      .all()
      .map((r) => ({
        categoryId: r.categoryId!,
        parentId: r.parentId,
        currency: r.currency,
        spent: 0 - r.total,
      }));
  }
  const sums = new Map<string, OwnSpend>();
  for (const r of db
    .select({
      categoryId: transactions.categoryId,
      parentId: categories.parentId,
      currency: transactions.currency,
      amount: transactions.amount,
      shareBps: accounts.shareBps,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(where, eq(accounts.userId, userId)))
    .all()) {
    const k = key(r.categoryId!, r.currency);
    const entry = sums.get(k) ?? {
      categoryId: r.categoryId!,
      parentId: r.parentId,
      currency: r.currency,
      spent: 0,
    };
    entry.spent -= shareOf(r.amount, r.shareBps);
    sums.set(k, entry);
  }
  return [...sums.values()];
}

const key = (categoryId: string, currency: string) =>
  `${categoryId}|${currency}`;

/** Own spending plus that of the category's subcategories. */
function rolledUp(own: OwnSpend[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, currency: string, n: number) =>
    out.set(key(id, currency), (out.get(key(id, currency)) ?? 0) + n);
  for (const r of own) {
    add(r.categoryId, r.currency, r.spent);
    if (r.parentId !== null) add(r.parentId, r.currency, r.spent);
  }
  return out;
}

export interface BudgetRow {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  parentName: string | null;
  color: string | null;
  icon: string | null;
  budget: Minor;
  /** Includes subcategories. */
  spent: Minor;
  /** Budget minus spent; negative when over budget. */
  remaining: Minor;
  over: boolean;
}

export interface UnbudgetedRow {
  categoryId: string;
  categoryName: string;
  parentName: string | null;
  color: string | null;
  icon: string | null;
  spent: Minor;
}

export interface CurrencyBudgetReport {
  currency: string;
  rows: BudgetRow[];
  unbudgeted: UnbudgetedRow[];
  /** Sums over budgets that are not already covered by a budget on their parent. */
  totalBudget: Minor;
  totalSpent: Minor;
}

export interface BudgetReport {
  month: string;
  currencies: CurrencyBudgetReport[];
}

/**
 * Spent against budget per category for a "YYYY-MM" month, per currency.
 * Amounts in different currencies are never combined.
 */
export function budgetReport(
  userId: string,
  month: string,
  basis: ShareBasis = "total",
): BudgetReport {
  const cats = new Map(
    getDB()
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        color: categories.color,
        icon: categories.icon,
      })
      .from(categories)
      .where(eq(categories.userId, userId))
      .all()
      .map((c) => [c.id, c]),
  );
  const own = ownSpend(userId, month, basis);
  const rolled = rolledUp(own);
  const all = listBudgets(userId).filter((b) => cats.has(b.categoryId));
  const budgeted = new Set(all.map((b) => key(b.categoryId, b.currency)));
  const parentName = (id: string) => {
    const parentId = cats.get(id)?.parentId;
    return parentId ? (cats.get(parentId)?.name ?? null) : null;
  };

  const currencies = new Set([
    ...all.map((b) => b.currency),
    ...own.filter((r) => r.spent > 0).map((r) => r.currency),
  ]);

  const result: CurrencyBudgetReport[] = [...currencies]
    .sort()
    .map((currency) => {
      const rows = all
        .filter((b) => b.currency === currency)
        .map((b): BudgetRow => {
          const c = cats.get(b.categoryId)!;
          const spent = rolled.get(key(b.categoryId, currency)) ?? 0;
          return {
            budgetId: b.id,
            categoryId: b.categoryId,
            categoryName: c.name,
            parentName: parentName(b.categoryId),
            color: c.color,
            icon: c.icon,
            budget: b.amount,
            spent: minor(spent),
            remaining: minor(b.amount - spent),
            over: spent > b.amount,
          };
        })
        .sort(
          (a, b) =>
            (a.parentName ?? a.categoryName).localeCompare(
              b.parentName ?? b.categoryName,
            ) ||
            Number(a.parentName !== null) - Number(b.parentName !== null) ||
            a.categoryName.localeCompare(b.categoryName),
        );

      const unbudgeted = own
        .filter((r) => {
          if (r.currency !== currency || r.spent <= 0) return false;
          if (budgeted.has(key(r.categoryId, currency))) return false;
          return !(
            r.parentId !== null && budgeted.has(key(r.parentId, currency))
          );
        })
        .map((r): UnbudgetedRow => {
          const c = cats.get(r.categoryId)!;
          return {
            categoryId: r.categoryId,
            categoryName: c.name,
            parentName: parentName(r.categoryId),
            color: c.color,
            icon: c.icon,
            spent: minor(r.spent),
          };
        })
        .sort((a, b) => b.spent - a.spent);

      const counted = rows.filter((r) => {
        const parentId = cats.get(r.categoryId)?.parentId;
        return !(parentId && budgeted.has(key(parentId, currency)));
      });
      return {
        currency,
        rows,
        unbudgeted,
        totalBudget: minor(counted.reduce((s, r) => s + r.budget, 0)),
        totalSpent: minor(counted.reduce((s, r) => s + r.spent, 0)),
      };
    });
  return { month, currencies: result };
}

export interface SpendingItem {
  categoryId: string;
  name: string;
  color: string | null;
  icon: string | null;
  /** Includes subcategories. */
  spent: Minor;
}

export interface CurrencySpending {
  currency: string;
  total: Minor;
  items: SpendingItem[];
}

export interface SpendingSummary {
  month: string;
  currencies: CurrencySpending[];
  /** Expense transactions in the month without a category. */
  uncategorizedCount: number;
}

/** Spending per top-level expense category for a "YYYY-MM" month, per currency. */
export function spendingByCategory(
  userId: string,
  month: string,
  basis: ShareBasis = "total",
): SpendingSummary {
  const db = getDB();
  const cats = new Map(
    db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        color: categories.color,
        icon: categories.icon,
      })
      .from(categories)
      .where(eq(categories.userId, userId))
      .all()
      .map((c) => [c.id, c]),
  );
  const totals = new Map<string, Map<string, number>>();
  for (const r of ownSpend(userId, month, basis)) {
    const topId =
      r.parentId !== null && cats.has(r.parentId) ? r.parentId : r.categoryId;
    const perCategory = totals.get(r.currency) ?? new Map<string, number>();
    perCategory.set(topId, (perCategory.get(topId) ?? 0) + r.spent);
    totals.set(r.currency, perCategory);
  }
  const currencies = [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, perCategory]): CurrencySpending => {
      const items = [...perCategory]
        .filter(([, spent]) => spent > 0)
        .map(([id, spent]): SpendingItem => {
          const c = cats.get(id)!;
          return {
            categoryId: id,
            name: c.name,
            color: c.color,
            icon: c.icon,
            spent: minor(spent),
          };
        })
        .sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
      return {
        currency,
        total: minor(items.reduce((s, i) => s + i.spent, 0)),
        items,
      };
    })
    .filter((c) => c.items.length > 0);

  const { first, last } = monthBounds(month);
  const uncategorizedCount = db
    .select({ n: count() })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.categoryId),
        lt(transactions.amount, minor(0)),
        gte(transactions.bookingDate, first),
        lte(transactions.bookingDate, last),
        notInLinkedTransfer,
      ),
    )
    .get()!.n;
  return { month, currencies, uncategorizedCount };
}
