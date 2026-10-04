import { and, eq } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import { getDB, plannedItems } from "$lib/server/db";
import { getAccount } from "$lib/server/ledger/accounts";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import type { ProjectedItem } from "./projection";
import type { PlannedItemInput } from "./schemas";

export const PLANNED_SOURCE = "planned";

export interface PlannedItemView {
  id: string;
  accountId: string | null;
  date: string;
  /** Signed: positive is income, negative is an expense. */
  amount: Minor;
  currency: string;
  label: string;
}

const columns = {
  id: plannedItems.id,
  accountId: plannedItems.accountId,
  date: plannedItems.date,
  amount: plannedItems.amount,
  currency: plannedItems.currency,
  label: plannedItems.label,
};

export function listPlannedItems(userId: string): PlannedItemView[] {
  return getDB()
    .select(columns)
    .from(plannedItems)
    .where(eq(plannedItems.userId, userId))
    .orderBy(plannedItems.date, plannedItems.id)
    .all();
}

function getPlannedItem(userId: string, id: string): PlannedItemView {
  const row = getDB()
    .select(columns)
    .from(plannedItems)
    .where(and(eq(plannedItems.userId, userId), eq(plannedItems.id, id)))
    .get();
  if (!row) throw notFound("Planned item");
  return row;
}

function toValues(userId: string, input: PlannedItemInput) {
  let currency = input.currency;
  if (input.accountId !== null) {
    try {
      currency = getAccount(userId, input.accountId).currency;
    } catch (err) {
      if (err instanceof LedgerError && err.code === "not_found") {
        throw new LedgerError("invalid", "Choose an account.", "accountId");
      }
      throw err;
    }
  }
  if (currency === null) {
    throw new LedgerError(
      "invalid",
      "Choose an account or enter a currency.",
      "currency",
    );
  }
  const parsed = parseMoneyInput(input.amount, currency);
  if (!parsed.ok) {
    throw new LedgerError("invalid", parsed.message, "amount");
  }
  const abs = Math.abs(parsed.value);
  if (abs === 0) {
    throw new LedgerError("invalid", "Amount must not be zero.", "amount");
  }
  return {
    accountId: input.accountId,
    date: input.date,
    label: input.label,
    currency,
    amount: minor(input.direction === "expense" ? -abs : abs),
  };
}

export function createPlannedItem(
  userId: string,
  input: PlannedItemInput,
): PlannedItemView {
  return getDB()
    .insert(plannedItems)
    .values({ userId, ...toValues(userId, input) })
    .returning(columns)
    .get();
}

export function updatePlannedItem(
  userId: string,
  id: string,
  input: PlannedItemInput,
): PlannedItemView {
  getPlannedItem(userId, id);
  getDB()
    .update(plannedItems)
    .set(toValues(userId, input))
    .where(and(eq(plannedItems.userId, userId), eq(plannedItems.id, id)))
    .run();
  return getPlannedItem(userId, id);
}

export function deletePlannedItem(userId: string, id: string): void {
  getPlannedItem(userId, id);
  getDB()
    .delete(plannedItems)
    .where(and(eq(plannedItems.userId, userId), eq(plannedItems.id, id)))
    .run();
}

export function plannedToItems(
  planned: readonly PlannedItemView[],
): ProjectedItem[] {
  return planned.map((p) => ({
    date: p.date,
    amount: p.amount,
    currency: p.currency,
    accountId: p.accountId,
    source: PLANNED_SOURCE,
    label: p.label,
    ref: p.id,
  }));
}
