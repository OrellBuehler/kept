import { and, asc, count, eq, ne } from "drizzle-orm";
import type { CategoryKind } from "$lib/category-types";
import {
  categories,
  first,
  getDB,
  isUniqueViolation,
  transactions,
  type DB,
  transaction,
} from "$lib/server/db";
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

export async function listCategories(userId: string): Promise<CategoryView[]> {
  return sortTree(
    await getDB()
      .select(columns)
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.name)),
  );
}

export async function listCategoriesWithCounts(
  userId: string,
): Promise<CategoryListItem[]> {
  const counts = new Map(
    (
      await getDB()
        .select({ id: transactions.categoryId, n: count() })
        .from(transactions)
        .where(eq(transactions.userId, userId))
        .groupBy(transactions.categoryId)
    ).map((r) => [r.id, r.n]),
  );
  return (await listCategories(userId)).map((c) => ({
    ...c,
    transactionCount: counts.get(c.id) ?? 0,
  }));
}

export async function getCategory(
  userId: string,
  id: string,
): Promise<CategoryView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Category");
  return row;
}

type Reader = Pick<DB, "select">;

const nameTaken = () =>
  new LedgerError(
    "conflict",
    "A category with this name already exists.",
    "name",
  );

/** Runs inside the transaction of createCategory / updateCategory. */
async function assertNameFree(
  tx: Reader,
  userId: string,
  name: string,
  exceptId?: string,
) {
  const clash = await first(
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.userId, userId),
          eq(categories.name, name),
          exceptId ? ne(categories.id, exceptId) : undefined,
        ),
      )
      .limit(1),
  );
  if (clash) throw nameTaken();
}

/**
 * The in-transaction name check is the friendly path; the unique index on
 * (user, name) is the backstop when two writes race, and maps to the same error.
 */
function mapNameViolation(err: unknown): never {
  if (isUniqueViolation(err)) throw nameTaken();
  throw err;
}

/** Runs inside the transaction of createCategory / updateCategory. */
async function assertParent(
  tx: Reader,
  userId: string,
  input: CategoryInput,
  selfId?: string,
): Promise<void> {
  if (input.parentId === null) return;
  if (input.parentId === selfId) {
    throw new LedgerError(
      "invalid",
      "A category cannot be its own parent.",
      "parentId",
    );
  }
  const parent = await first(
    tx
      .select(columns)
      .from(categories)
      .where(
        and(eq(categories.userId, userId), eq(categories.id, input.parentId)),
      )
      .limit(1),
  );
  if (!parent) {
    throw new LedgerError("invalid", "Choose a valid parent.", "parentId");
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
    const children = (await first(
      tx
        .select({ n: count() })
        .from(categories)
        .where(
          and(eq(categories.userId, userId), eq(categories.parentId, selfId)),
        )
        .limit(1),
    ))!.n;
    if (children > 0) {
      throw new LedgerError(
        "invalid",
        "A category with subcategories cannot become a subcategory.",
        "parentId",
      );
    }
  }
}

/** Runs inside the transaction of updateCategory. */
async function assertKindMatchesChildren(
  tx: Reader,
  userId: string,
  id: string,
  kind: CategoryKind,
) {
  const mismatched = await first(
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.userId, userId),
          eq(categories.parentId, id),
          ne(categories.kind, kind),
        ),
      )
      .limit(1),
  );
  if (mismatched) {
    throw new LedgerError(
      "invalid",
      "Change the type of its subcategories first.",
      "kind",
    );
  }
}

export async function createCategory(
  userId: string,
  input: CategoryInput,
): Promise<CategoryView> {
  try {
    return await transaction(async (tx) => {
      await assertNameFree(tx, userId, input.name);
      await assertParent(tx, userId, input);
      return (await first(
        tx
          .insert(categories)
          .values({ userId, ...input })
          .returning(columns),
      ))!;
    });
  } catch (err) {
    mapNameViolation(err);
  }
}

export async function updateCategory(
  userId: string,
  id: string,
  input: CategoryInput,
): Promise<CategoryView> {
  try {
    await transaction(async (tx) => {
      const found = await first(
        tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.userId, userId), eq(categories.id, id)))
          .limit(1),
      );
      if (!found) throw notFound("Category");
      await assertNameFree(tx, userId, input.name, id);
      await assertParent(tx, userId, input, id);
      await assertKindMatchesChildren(tx, userId, id, input.kind);
      await tx
        .update(categories)
        .set(input)
        .where(and(eq(categories.userId, userId), eq(categories.id, id)));
    });
  } catch (err) {
    mapNameViolation(err);
  }
  return await getCategory(userId, id);
}

/**
 * Transactions in the category become uncategorized, its rules and budgets
 * are removed, and its subcategories become top-level categories.
 */
export async function deleteCategory(
  userId: string,
  id: string,
): Promise<void> {
  await getCategory(userId, id);
  await getDB()
    .delete(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)));
}

/** Sets or clears a transaction's category. A manual choice is never overwritten by rules. */
export async function assignCategory(
  userId: string,
  transactionId: string,
  categoryId: string | null,
): Promise<void> {
  await transaction(async (tx) => {
    const found = await first(
      tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, transactionId),
          ),
        )
        .limit(1),
    );
    if (!found) throw notFound("Transaction");
    if (categoryId !== null) {
      const category = await first(
        tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(eq(categories.userId, userId), eq(categories.id, categoryId)),
          )
          .limit(1),
      );
      if (!category) throw notFound("Category");
    }
    await tx
      .update(transactions)
      .set({ categoryId })
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, transactionId),
        ),
      );
  });
}
