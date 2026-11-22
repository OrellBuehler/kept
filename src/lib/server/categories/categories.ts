import { and, asc, count, eq, ne } from "drizzle-orm";
import type { CategoryKind } from "$lib/category-types";
import { recordChange, recordUpdate } from "$lib/server/audit/record";
import {
  categoryFields,
  ruleFields,
  transactionSummary,
} from "$lib/server/audit/snapshots";
import {
  budgets,
  categories,
  categoryRules,
  deductionMappings,
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

/**
 * The tree rules (one level deep, a child has its parent's kind) read other
 * categories, so two concurrent changes could each pass them and together break
 * them: A under B while B goes under C. The lock makes them take turns.
 */
export const categoryTreeLock = (userId: string) => `categories:${userId}`;

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
export function mapNameViolation(err: unknown): never {
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
    return await transaction(
      async (tx) => {
        await assertNameFree(tx, userId, input.name);
        await assertParent(tx, userId, input);
        const created = (await first(
          tx
            .insert(categories)
            .values({ userId, ...input })
            .returning(columns),
        ))!;
        await recordChange({
          userId,
          action: "category.create",
          entityId: created.id,
          summary: created.name,
          after: categoryFields(created),
        });
        return created;
      },
      { lock: categoryTreeLock(userId) },
    );
  } catch (err) {
    mapNameViolation(err);
  }
}

/**
 * Validates and applies an update inside a transaction that holds
 * `categoryTreeLock(userId)`. Does not write the change log: the callers
 * (an edit, and the revert of one) each write their own entry.
 */
export async function updateCategoryInTx(
  tx: Pick<DB, "select" | "update">,
  userId: string,
  id: string,
  input: CategoryInput,
): Promise<{ before: CategoryView; after: CategoryView }> {
  const before = await first(
    tx
      .select(columns)
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1),
  );
  if (!before) throw notFound("Category");
  await assertNameFree(tx, userId, input.name, id);
  await assertParent(tx, userId, input, id);
  await assertKindMatchesChildren(tx, userId, id, input.kind);
  await tx
    .update(categories)
    .set(input)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)));
  return { before, after: { id, ...input } };
}

export async function updateCategory(
  userId: string,
  id: string,
  input: CategoryInput,
): Promise<CategoryView> {
  try {
    await transaction(
      async (tx) => {
        const { before, after } = await updateCategoryInTx(
          tx,
          userId,
          id,
          input,
        );
        await recordUpdate(
          {
            userId,
            action: "category.update",
            entityId: id,
            summary: after.name,
          },
          categoryFields(before),
          categoryFields(after),
        );
      },
      { lock: categoryTreeLock(userId) },
    );
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
  // Under the tree lock: a category being moved under this one must not race the delete.
  await transaction(
    async (tx) => {
      const row = await first(
        tx
          .select()
          .from(categories)
          .where(and(eq(categories.userId, userId), eq(categories.id, id)))
          .limit(1),
      );
      if (!row) throw notFound("Category");
      // What the delete takes along or detaches, so the change log can bring it back.
      const children = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.userId, userId), eq(categories.parentId, id)))
        .orderBy(asc(categories.id));
      const categorized = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(eq(transactions.userId, userId), eq(transactions.categoryId, id)),
        )
        .orderBy(asc(transactions.id));
      const rules = await tx
        .select()
        .from(categoryRules)
        .where(
          and(
            eq(categoryRules.userId, userId),
            eq(categoryRules.categoryId, id),
          ),
        )
        .orderBy(asc(categoryRules.seq), asc(categoryRules.id));
      const budgetRows = await tx
        .select()
        .from(budgets)
        .where(and(eq(budgets.userId, userId), eq(budgets.categoryId, id)))
        .orderBy(asc(budgets.id));
      const mappings = await tx
        .select()
        .from(deductionMappings)
        .where(
          and(
            eq(deductionMappings.userId, userId),
            eq(deductionMappings.categoryId, id),
          ),
        )
        .orderBy(asc(deductionMappings.id));
      await tx
        .delete(categories)
        .where(and(eq(categories.userId, userId), eq(categories.id, id)));
      await recordChange({
        userId,
        action: "category.delete",
        entityId: id,
        summary: row.name,
        before: {
          ...categoryFields(row),
          createdAt: row.createdAt.getTime(),
          childIds: children.map((c) => c.id),
          transactionIds: categorized.map((t) => t.id),
          rules: rules.map((r) => ({
            id: r.id,
            ...ruleFields(r),
            seq: r.seq,
            createdAt: r.createdAt.getTime(),
          })),
          budgets: budgetRows.map((b) => ({
            id: b.id,
            currency: b.currency,
            amount: b.amount,
            createdAt: b.createdAt.getTime(),
          })),
          deductionMappings: mappings.map((m) => ({
            id: m.id,
            deductionType: m.deductionType,
            createdAt: m.createdAt.getTime(),
          })),
        },
      });
    },
    { lock: categoryTreeLock(userId) },
  );
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
        .select({
          id: transactions.id,
          categoryId: transactions.categoryId,
          counterpartyName: transactions.counterpartyName,
          description: transactions.description,
        })
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
    await recordUpdate(
      {
        userId,
        action: "transaction.update",
        entityId: transactionId,
        summary: transactionSummary(found),
      },
      { categoryId: found.categoryId },
      { categoryId },
    );
  });
}
