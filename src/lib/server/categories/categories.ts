import { and, asc, count, eq, ne } from "drizzle-orm";
import type { CategoryKind } from "$lib/category-types";
import { categories, getDB, transactions } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { CategoryInput } from "./schemas";

export interface CategoryView {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  color: string | null;
  icon: string | null;
}

export interface CategoryListItem extends CategoryView {
  transactionCount: number;
}

const columns = {
  id: categories.id,
  name: categories.name,
  parentId: categories.parentId,
  kind: categories.kind,
  color: categories.color,
  icon: categories.icon,
};

/** Parents first (by name), each followed by its subcategories (by name). */
function sortTree<T extends CategoryView>(rows: T[]): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const ids = new Set(rows.map((r) => r.id));
  const top = rows.filter((r) => r.parentId === null || !ids.has(r.parentId));
  return top
    .sort(byName)
    .flatMap((p) => [
      p,
      ...rows.filter((r) => r.parentId === p.id).sort(byName),
    ]);
}

export function listCategories(userId: string): CategoryView[] {
  return sortTree(
    getDB()
      .select(columns)
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.name))
      .all(),
  );
}

export function listCategoriesWithCounts(userId: string): CategoryListItem[] {
  const counts = new Map(
    getDB()
      .select({ id: transactions.categoryId, n: count() })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .groupBy(transactions.categoryId)
      .all()
      .map((r) => [r.id, r.n]),
  );
  return listCategories(userId).map((c) => ({
    ...c,
    transactionCount: counts.get(c.id) ?? 0,
  }));
}

export function getCategory(userId: string, id: string): CategoryView {
  const row = getDB()
    .select(columns)
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .get();
  if (!row) throw notFound("Category");
  return row;
}

function assertNameFree(userId: string, name: string, exceptId?: string) {
  const clash = getDB()
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.name, name),
        exceptId ? ne(categories.id, exceptId) : undefined,
      ),
    )
    .get();
  if (clash) {
    throw new LedgerError(
      "conflict",
      "A category with this name already exists.",
      "name",
    );
  }
}

function assertParent(
  userId: string,
  input: CategoryInput,
  selfId?: string,
): void {
  if (input.parentId === null) return;
  if (input.parentId === selfId) {
    throw new LedgerError(
      "invalid",
      "A category cannot be its own parent.",
      "parentId",
    );
  }
  let parent: CategoryView;
  try {
    parent = getCategory(userId, input.parentId);
  } catch (err) {
    if (err instanceof LedgerError && err.code === "not_found") {
      throw new LedgerError("invalid", "Choose a valid parent.", "parentId");
    }
    throw err;
  }
  if (parent.parentId !== null) {
    throw new LedgerError(
      "invalid",
      "Categories can only be nested one level deep.",
      "parentId",
    );
  }
  if (parent.kind !== input.kind) {
    throw new LedgerError(
      "invalid",
      "A subcategory must have the same type as its parent.",
      "kind",
    );
  }
  if (selfId !== undefined) {
    const children = getDB()
      .select({ n: count() })
      .from(categories)
      .where(
        and(eq(categories.userId, userId), eq(categories.parentId, selfId)),
      )
      .get()!.n;
    if (children > 0) {
      throw new LedgerError(
        "invalid",
        "A category with subcategories cannot become a subcategory.",
        "parentId",
      );
    }
  }
}

function assertKindMatchesChildren(
  userId: string,
  id: string,
  kind: CategoryKind,
) {
  const mismatched = getDB()
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.parentId, id),
        ne(categories.kind, kind),
      ),
    )
    .get();
  if (mismatched) {
    throw new LedgerError(
      "invalid",
      "Change the type of its subcategories first.",
      "kind",
    );
  }
}

export function createCategory(
  userId: string,
  input: CategoryInput,
): CategoryView {
  assertNameFree(userId, input.name);
  assertParent(userId, input);
  return getDB()
    .insert(categories)
    .values({ userId, ...input })
    .returning(columns)
    .get();
}

export function updateCategory(
  userId: string,
  id: string,
  input: CategoryInput,
): CategoryView {
  getCategory(userId, id);
  assertNameFree(userId, input.name, id);
  assertParent(userId, input, id);
  assertKindMatchesChildren(userId, id, input.kind);
  getDB()
    .update(categories)
    .set(input)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .run();
  return getCategory(userId, id);
}

/**
 * Transactions in the category become uncategorized, its rules and budgets
 * are removed, and its subcategories become top-level categories.
 */
export function deleteCategory(userId: string, id: string): void {
  getCategory(userId, id);
  getDB()
    .delete(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .run();
}

/** Sets or clears a transaction's category. A manual choice is never overwritten by rules. */
export function assignCategory(
  userId: string,
  transactionId: string,
  categoryId: string | null,
): void {
  const db = getDB();
  const tx = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, transactionId)),
    )
    .get();
  if (!tx) throw notFound("Transaction");
  if (categoryId !== null) getCategory(userId, categoryId);
  db.update(transactions)
    .set({ categoryId })
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, transactionId)),
    )
    .run();
}
