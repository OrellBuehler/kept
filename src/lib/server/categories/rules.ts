import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { AmountSign } from "$lib/category-types";
import { normalizeIban } from "$lib/iban";
import {
  categories,
  categoryRules,
  first,
  getDB,
  transactions,
  type DB,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { RuleInput } from "./schemas";

export interface CategoryRule {
  id: string;
  categoryId: string;
  priority: number;
  counterpartyContains: string | null;
  descriptionContains: string | null;
  counterpartyIban: string | null;
  amountSign: AmountSign | null;
}

export interface RuleView extends CategoryRule {
  categoryName: string;
}

export interface RuleSubject {
  amount: number;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
}

const contains = (haystack: string | null, needle: string) =>
  haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());

/** All set conditions must match; text matching ignores case. */
export function ruleMatches(rule: CategoryRule, tx: RuleSubject): boolean {
  if (
    rule.counterpartyContains !== null &&
    !contains(tx.counterpartyName, rule.counterpartyContains)
  ) {
    return false;
  }
  if (
    rule.descriptionContains !== null &&
    !contains(tx.description, rule.descriptionContains)
  ) {
    return false;
  }
  if (rule.counterpartyIban !== null) {
    if (
      tx.counterpartyIban === null ||
      normalizeIban(tx.counterpartyIban) !==
        normalizeIban(rule.counterpartyIban)
    ) {
      return false;
    }
  }
  if (rule.amountSign === "income" && !(tx.amount > 0)) return false;
  if (rule.amountSign === "expense" && !(tx.amount < 0)) return false;
  return true;
}

/** First matching rule's category. `rules` must already be in priority order. */
export function categorize(
  rules: readonly CategoryRule[],
  tx: RuleSubject,
): string | null {
  for (const rule of rules) if (ruleMatches(rule, tx)) return rule.categoryId;
  return null;
}

const ruleColumns = {
  id: categoryRules.id,
  categoryId: categoryRules.categoryId,
  priority: categoryRules.priority,
  counterpartyContains: categoryRules.counterpartyContains,
  descriptionContains: categoryRules.descriptionContains,
  counterpartyIban: categoryRules.counterpartyIban,
  amountSign: categoryRules.amountSign,
};

/** The user's rules in the order they are applied. */
export async function loadRules(userId: string): Promise<CategoryRule[]> {
  return await getDB()
    .select(ruleColumns)
    .from(categoryRules)
    .where(eq(categoryRules.userId, userId))
    .orderBy(
      asc(categoryRules.priority),
      asc(categoryRules.createdAt),
      asc(categoryRules.seq),
      asc(categoryRules.id),
    );
}

export async function listRules(userId: string): Promise<RuleView[]> {
  const names = new Map(
    (
      await getDB()
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.userId, userId))
    ).map((c) => [c.id, c.name]),
  );
  return (await loadRules(userId)).map((r) => ({
    ...r,
    categoryName: names.get(r.categoryId) ?? "",
  }));
}

function normalized(input: RuleInput): RuleInput {
  return {
    ...input,
    counterpartyIban:
      input.counterpartyIban === null
        ? null
        : normalizeIban(input.counterpartyIban),
  };
}

async function getRule(userId: string, id: string): Promise<CategoryRule> {
  const row = await first(
    getDB()
      .select(ruleColumns)
      .from(categoryRules)
      .where(and(eq(categoryRules.userId, userId), eq(categoryRules.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Rule");
  return row;
}

/** Runs inside the transaction of createRule / updateRule. */
async function assertCategory(
  tx: Pick<DB, "select">,
  userId: string,
  categoryId: string,
) {
  const found = await first(
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, categoryId)))
      .limit(1),
  );
  if (!found) {
    throw new LedgerError("invalid", "Choose a category.", "categoryId");
  }
}

export async function createRule(
  userId: string,
  input: RuleInput,
): Promise<CategoryRule> {
  return await transaction(async (tx) => {
    await assertCategory(tx, userId, input.categoryId);
    return (await first(
      tx
        .insert(categoryRules)
        .values({ userId, ...normalized(input) })
        .returning(ruleColumns),
    ))!;
  });
}

export async function updateRule(
  userId: string,
  id: string,
  input: RuleInput,
): Promise<CategoryRule> {
  await transaction(async (tx) => {
    const found = await first(
      tx
        .select({ id: categoryRules.id })
        .from(categoryRules)
        .where(and(eq(categoryRules.userId, userId), eq(categoryRules.id, id)))
        .limit(1),
    );
    if (!found) throw notFound("Rule");
    await assertCategory(tx, userId, input.categoryId);
    await tx
      .update(categoryRules)
      .set(normalized(input))
      .where(and(eq(categoryRules.userId, userId), eq(categoryRules.id, id)));
  });
  return await getRule(userId, id);
}

export async function deleteRule(userId: string, id: string): Promise<void> {
  await getRule(userId, id);
  await getDB()
    .delete(categoryRules)
    .where(and(eq(categoryRules.userId, userId), eq(categoryRules.id, id)));
}

export interface ApplyResult {
  scanned: number;
  categorized: number;
}

/**
 * Runs the user's rules over transactions that have no category. Rows that
 * already have one, whether set by hand or by an earlier run, are never
 * touched, so a manual choice always wins. Mirrors (counter-transactions Kept
 * created from a transfer) are never categorized by rules.
 */
export async function applyRulesToUncategorized(
  userId: string,
): Promise<ApplyResult> {
  const rules = await loadRules(userId);
  const db = getDB();
  const rows = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      counterpartyName: transactions.counterpartyName,
      counterpartyIban: transactions.counterpartyIban,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.categoryId),
        ne(transactions.source, "mirror"),
      ),
    );
  if (rules.length === 0) return { scanned: rows.length, categorized: 0 };
  return await transaction(async (tx) => {
    let categorized = 0;
    for (const row of rows) {
      const categoryId = categorize(rules, row);
      if (categoryId === null) continue;
      categorized += (
        await tx
          .update(transactions)
          .set({ categoryId })
          .where(
            and(
              eq(transactions.userId, userId),
              eq(transactions.id, row.id),
              isNull(transactions.categoryId),
            ),
          )
          .returning({ id: transactions.id })
      ).length;
    }
    return { scanned: rows.length, categorized };
  });
}
