import { and, eq } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import { first, getDB, plannedItems } from "$lib/server/db";
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

export async function listPlannedItems(
  userId: string,
): Promise<PlannedItemView[]> {
  return await getDB()
    .select(columns)
    .from(plannedItems)
    .where(eq(plannedItems.userId, userId))
    .orderBy(plannedItems.date, plannedItems.id);
}

async function getPlannedItem(
  userId: string,
  id: string,
): Promise<PlannedItemView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(plannedItems)
      .where(and(eq(plannedItems.userId, userId), eq(plannedItems.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Planned item");
  return row;
}

async function toValues(userId: string, input: PlannedItemInput) {
  let currency = input.currency;
  if (input.accountId !== null) {
    try {
      currency = (await getAccount(userId, input.accountId)).currency;
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

export async function createPlannedItem(
  userId: string,
  input: PlannedItemInput,
): Promise<PlannedItemView> {
  const values = await toValues(userId, input);
  return (
    await getDB()
      .insert(plannedItems)
      .values({ userId, ...values })
      .returning(columns)
  )[0]!;
}

export async function updatePlannedItem(
  userId: string,
  id: string,
  input: PlannedItemInput,
): Promise<PlannedItemView> {
  await getPlannedItem(userId, id);
  const values = await toValues(userId, input);
  const updated = await getDB()
    .update(plannedItems)
    .set(values)
    .where(and(eq(plannedItems.userId, userId), eq(plannedItems.id, id)))
    .returning(columns);
  if (updated.length === 0) throw notFound("Planned item");
  return updated[0]!;
}

export async function deletePlannedItem(
  userId: string,
  id: string,
): Promise<void> {
  const deleted = await getDB()
    .delete(plannedItems)
    .where(and(eq(plannedItems.userId, userId), eq(plannedItems.id, id)))
    .returning({ id: plannedItems.id });
  if (deleted.length === 0) throw notFound("Planned item");
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
