/**
 * How each kind of change is undone. A handler runs inside the revert
 * transaction (which holds `lock`), checks that the data still looks the way
 * the entry left it, performs the inverse change with plain queries (it never
 * writes the change log itself) and returns the entry the revert should write.
 */
import { isDeepStrictEqual } from "node:util";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AllocationOrigin } from "$lib/bill-types";
import type { CategoryKind } from "$lib/category-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  billAllocations,
  bills,
  budgets,
  categories,
  categoryRules,
  deductionMappings,
  documents,
  first,
  matchDismissals,
  transactions,
  afterCommit,
  type DB,
} from "$lib/server/db";
import {
  allocateRow,
  lockedTransactionRowInTx,
} from "$lib/server/bills/allocations";
import {
  billSummary,
  billsLock,
  deleteDocumentIfUnused,
  getBillInTx,
  type BillView,
} from "$lib/server/bills/bills";
import { removeAllocationInTx } from "$lib/server/bills/suggestions";
import {
  categoryTreeLock,
  updateCategoryInTx,
} from "$lib/server/categories/categories";
import { updateRuleInTx } from "$lib/server/categories/rules";
import type { CategoryInput, RuleInput } from "$lib/server/categories/schemas";
import { emitBillChanged } from "$lib/server/events";
import { LedgerError } from "$lib/server/ledger/errors";
import { ledgerLock } from "$lib/server/ledger/lock";
import {
  allocationSnapshot,
  billFields,
  billSnapshot,
  categoryFields,
  dismissalSnapshot,
  REVERTIBLE_TRANSACTION_FIELDS,
  ruleFields,
  transactionSummary,
} from "./snapshots";
import {
  opOf,
  RevertError,
  type ChangeAction,
  type ChangeEntry,
  type Snapshot,
} from "./types";

export type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;

/** The change a revert makes, as the entry it writes. */
export interface Inverse {
  action: ChangeAction;
  entityId: string;
  summary: string | null;
  before?: Snapshot | null;
  after?: Snapshot | null;
  /** Work that must follow the commit (file removal); a failure is logged, never fails the revert. */
  postCommit?: () => Promise<void>;
}

export interface RevertContext {
  tx: Tx;
  userId: string;
  entry: ChangeEntry;
  /** What could not be restored along with the entry. */
  warnings: string[];
}

export interface RevertHandler {
  /** The one lock key the revert transaction takes. */
  lock(userId: string, entry: ChangeEntry): string;
  /** Why this entry can never be reverted, judged from the entry alone. */
  blocker(entry: ChangeEntry): string | null;
  revert(ctx: RevertContext): Promise<Inverse>;
}

const conflict = (message: string) => new RevertError("conflict", message);

function snapshotOf(value: Snapshot | null, what: string): Snapshot {
  if (value === null) {
    throw new RevertError(
      "not_revertible",
      `This entry has no saved ${what}, so it cannot be reverted.`,
    );
  }
  return value;
}

/** Refuses when any of `expected`'s fields differs from `current`. Names the fields, never their values. */
function assertUnchanged(
  current: Snapshot,
  expected: Snapshot,
  what: string,
): void {
  const changed = Object.keys(expected).filter(
    (k) => !isDeepStrictEqual(current[k] ?? null, expected[k] ?? null),
  );
  if (changed.length > 0) {
    throw conflict(
      `${what} was changed after this entry (${changed.join(", ")}). Revert refused so that later changes are not lost.`,
    );
  }
}

function without(snapshot: Snapshot, ...keys: string[]): Snapshot {
  const copy: Snapshot = { ...snapshot };
  for (const k of keys) delete copy[k];
  return copy;
}

const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => (v ?? null) as string | null;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Runs a LedgerError of a shared validation as a refused revert. */
async function asConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LedgerError && !(err instanceof RevertError)) {
      throw conflict(err.message);
    }
    throw err;
  }
}

// --- bills ---------------------------------------------------------------

const BILL_FIELD_KEYS = new Set(Object.keys(billFields({} as BillView)));
// `billFields` reads properties of its argument, so an empty object yields the keys.

async function findBill(
  tx: Tx,
  userId: string,
  id: string,
): Promise<BillView | null> {
  try {
    return await getBillInTx(tx, userId, id);
  } catch (err) {
    if (err instanceof LedgerError && err.code === "not_found") return null;
    throw err;
  }
}

async function billLinks(
  tx: Tx,
  userId: string,
  billId: string,
): Promise<{ allocations: number; dismissals: number }> {
  const allocations = (await first(
    tx
      .select({ n: count() })
      .from(billAllocations)
      .where(
        and(
          eq(billAllocations.userId, userId),
          eq(billAllocations.billId, billId),
        ),
      )
      .limit(1),
  ))!.n;
  const dismissals = (await first(
    tx
      .select({ n: count() })
      .from(matchDismissals)
      .where(
        and(
          eq(matchDismissals.userId, userId),
          eq(matchDismissals.billId, billId),
        ),
      )
      .limit(1),
  ))!.n;
  return { allocations, dismissals };
}

async function exists(
  tx: Tx,
  table: typeof accounts | typeof documents,
  userId: string,
  id: string,
): Promise<boolean> {
  const row = await first(
    tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.id, id)))
      .limit(1),
  );
  return row !== undefined;
}

type BillInsert = typeof bills.$inferInsert;

/** The columns of a bill snapshot's fields (the extraction is stored as JSON text). */
function billColumns(values: Snapshot): Partial<BillInsert> {
  const { extraction, ...rest } = values;
  const out: Record<string, unknown> = { ...rest };
  if ("extraction" in values) {
    out.extraction = extraction === null ? null : JSON.stringify(extraction);
  }
  return out as Partial<BillInsert>;
}

const billHandler: RevertHandler = {
  lock: (userId) => billsLock(userId).lock,
  blocker: () => null,
  async revert(ctx) {
    switch (opOf(ctx.entry.action)) {
      case "create":
        return await revertBillCreate(ctx);
      case "update":
        return await revertBillUpdate(ctx);
      default:
        return await revertBillDelete(ctx);
    }
  },
};

async function revertBillCreate({
  tx,
  userId,
  entry,
}: RevertContext): Promise<Inverse> {
  const current = await findBill(tx, userId, entry.entityId);
  if (!current) throw conflict("The bill no longer exists.");
  assertUnchanged(
    billFields(current),
    without(snapshotOf(entry.after, "state"), "createdAt"),
    "The bill",
  );
  const links = await billLinks(tx, userId, current.id);
  if (links.allocations > 0 || links.dismissals > 0) {
    throw conflict(
      "Payments were matched to this bill after it was created. Undo those first.",
    );
  }
  await tx
    .delete(bills)
    .where(and(eq(bills.userId, userId), eq(bills.id, current.id)));
  afterCommit(() => emitBillChanged(userId, current.id));
  return {
    action: "bill.delete",
    entityId: current.id,
    summary: billSummary(current),
    before: billSnapshot(current),
    postCommit: async () => {
      await deleteDocumentIfUnused(userId, current.documentId);
    },
  };
}

async function revertBillUpdate({
  tx,
  userId,
  entry,
}: RevertContext): Promise<Inverse> {
  const before = snapshotOf(entry.before, "state");
  const after = snapshotOf(entry.after, "state");
  const keys = Object.keys(after);
  if (keys.some((k) => !BILL_FIELD_KEYS.has(k))) {
    throw new RevertError(
      "not_revertible",
      "This entry changed something that cannot be restored.",
    );
  }
  // A no-op update takes the row's write lock: writers that do not hold the
  // bills lock (attaching a document) queue behind it, then the compare below
  // sees their committed result.
  await tx
    .update(bills)
    .set({ updatedAt: sql`${bills.updatedAt}` })
    .where(and(eq(bills.userId, userId), eq(bills.id, entry.entityId)));
  const current = await findBill(tx, userId, entry.entityId);
  if (!current) throw conflict("The bill no longer exists.");
  assertUnchanged(billFields(current), after, "The bill");
  if (
    (keys.includes("kind") || keys.includes("currency")) &&
    (await billLinks(tx, userId, current.id)).allocations > 0
  ) {
    throw conflict(
      "Payments are matched to this bill now, which fixes its type and currency. Undo those first.",
    );
  }
  if (
    typeof before.expectedAccountId === "string" &&
    !(await exists(tx, accounts, userId, before.expectedAccountId))
  ) {
    throw conflict("The account this bill expected no longer exists.");
  }
  if (
    typeof before.documentId === "string" &&
    !(await exists(tx, documents, userId, before.documentId))
  ) {
    throw conflict("The document that was attached no longer exists.");
  }
  await tx
    .update(bills)
    .set(billColumns(before))
    .where(and(eq(bills.userId, userId), eq(bills.id, current.id)));
  afterCommit(() => emitBillChanged(userId, current.id));
  const only = keys.length === 1 && keys[0] === "cancelled";
  return {
    action: only
      ? before.cancelled === true
        ? "bill.cancel"
        : "bill.uncancel"
      : "bill.update",
    entityId: current.id,
    summary: billSummary(current),
    before: after,
    after: before,
  };
}

interface DeletedBill extends Snapshot {
  allocations?: Array<{
    id: string;
    transactionId: string;
    amount: Minor;
    origin: AllocationOrigin;
  }>;
  dismissals?: Array<{ id: string; transactionId: string }>;
}

async function revertBillDelete({
  tx,
  userId,
  entry,
  warnings,
}: RevertContext): Promise<Inverse> {
  const saved = snapshotOf(entry.before, "state") as DeletedBill;
  const id = entry.entityId;
  if (await findBill(tx, userId, id)) {
    throw conflict("A bill with this id exists already.");
  }
  if (typeof saved.externalSource === "string") {
    const clash = await first(
      tx
        .select({ id: bills.id })
        .from(bills)
        .where(
          and(
            eq(bills.userId, userId),
            eq(bills.externalSource, saved.externalSource),
            eq(bills.externalRef, str(saved.externalRef)),
          ),
        )
        .limit(1),
    );
    if (clash) {
      throw conflict("This bill was imported again after it was deleted.");
    }
  }
  const fields = without(
    saved,
    "createdAt",
    "allocations",
    "dismissals",
  ) as Snapshot;
  if (
    typeof saved.expectedAccountId === "string" &&
    !(await exists(tx, accounts, userId, saved.expectedAccountId))
  ) {
    fields.expectedAccountId = null;
    warnings.push("The account the bill expected no longer exists.");
  }
  if (
    typeof saved.documentId === "string" &&
    !(await exists(tx, documents, userId, saved.documentId))
  ) {
    fields.documentId = null;
    warnings.push("The attached document was removed with the bill.");
  }
  await tx.insert(bills).values({
    ...(billColumns(fields) as BillInsert),
    id,
    userId,
    currency: str(saved.currency),
    createdAt: new Date(saved.createdAt as number),
  });
  const restored = await getBillInTx(tx, userId, id);
  let lost = 0;
  for (const a of saved.allocations ?? []) {
    try {
      const row = await lockedTransactionRowInTx(tx, userId, a.transactionId);
      await allocateRow(tx, userId, restored, row, a.amount, a.origin, {
        id: a.id,
      });
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      lost++;
    }
  }
  if (lost > 0) {
    warnings.push(
      `${plural(lost, "matched payment")} could not be matched again (the payment is gone or matched elsewhere).`,
    );
  }
  for (const d of saved.dismissals ?? []) {
    const tr = await first(
      tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, d.transactionId),
          ),
        )
        .limit(1),
    );
    if (!tr) continue;
    await tx
      .insert(matchDismissals)
      .values({ id: d.id, userId, billId: id, transactionId: d.transactionId })
      .onConflictDoNothing();
  }
  afterCommit(() => emitBillChanged(userId, id));
  return {
    action: "bill.create",
    entityId: id,
    summary: billSummary(restored),
    after: billSnapshot(restored),
  };
}

// --- allocations ---------------------------------------------------------

const allocationHandler: RevertHandler = {
  lock: (userId) => billsLock(userId).lock,
  blocker: () => null,
  async revert({ tx, userId, entry, warnings: _warnings }) {
    if (opOf(entry.action) === "create") {
      const saved = snapshotOf(entry.after, "state");
      const current = await first(
        tx
          .select({
            billId: billAllocations.billId,
            transactionId: billAllocations.transactionId,
            amount: billAllocations.amount,
            origin: billAllocations.origin,
          })
          .from(billAllocations)
          .where(
            and(
              eq(billAllocations.userId, userId),
              eq(billAllocations.id, entry.entityId),
            ),
          )
          .limit(1),
      );
      if (!current) throw conflict("This payment match was removed already.");
      assertUnchanged(allocationSnapshot(current), saved, "The match");
      const removed = await removeAllocationInTx(tx, userId, entry.entityId);
      const bill = await getBillInTx(tx, userId, removed.billId);
      afterCommit(() => emitBillChanged(userId, removed.billId));
      return {
        action: "allocation.delete",
        entityId: removed.id,
        summary: billSummary(bill),
        before: allocationSnapshot(removed),
        after: removed.dismissed ? { dismissedPair: true } : null,
      };
    }
    const saved = snapshotOf(entry.before, "state");
    const bill = await findBill(tx, userId, str(saved.billId));
    if (!bill) throw conflict("The bill no longer exists.");
    let row;
    try {
      row = await lockedTransactionRowInTx(
        tx,
        userId,
        str(saved.transactionId),
      );
    } catch (err) {
      if (err instanceof LedgerError && err.code === "not_found") {
        throw conflict("The payment no longer exists.");
      }
      throw err;
    }
    const taken = await first(
      tx
        .select({ id: billAllocations.id })
        .from(billAllocations)
        .where(
          and(
            eq(billAllocations.userId, userId),
            eq(billAllocations.id, entry.entityId),
          ),
        )
        .limit(1),
    );
    if (taken) throw conflict("This payment match exists again already.");
    const amount = saved.amount as Minor;
    const origin = saved.origin as AllocationOrigin;
    await asConflict(
      async () =>
        await allocateRow(tx, userId, bill, row, amount, origin, {
          id: entry.entityId,
        }),
    );
    afterCommit(() => emitBillChanged(userId, bill.id));
    return {
      action: "allocation.create",
      entityId: entry.entityId,
      summary: billSummary(bill),
      after: allocationSnapshot({
        billId: bill.id,
        transactionId: row.id,
        amount,
        origin,
      }),
    };
  },
};

const dismissalHandler: RevertHandler = {
  lock: (userId) => billsLock(userId).lock,
  blocker: () => null,
  async revert({ tx, userId, entry }) {
    const saved = snapshotOf(
      opOf(entry.action) === "create" ? entry.after : entry.before,
      "state",
    );
    const billId = str(saved.billId);
    const transactionId = str(saved.transactionId);
    const bill = await findBill(tx, userId, billId);
    if (!bill) throw conflict("The bill no longer exists.");
    if (opOf(entry.action) === "create") {
      const removed = await tx
        .delete(matchDismissals)
        .where(
          and(
            eq(matchDismissals.userId, userId),
            eq(matchDismissals.id, entry.entityId),
          ),
        )
        .returning({ id: matchDismissals.id });
      if (removed.length === 0) {
        throw conflict("This dismissal was removed already.");
      }
      return {
        action: "match_dismissal.delete",
        entityId: entry.entityId,
        summary: billSummary(bill),
        before: dismissalSnapshot({ billId, transactionId }),
      };
    }
    const tr = await first(
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
    if (!tr) throw conflict("The payment no longer exists.");
    const pair = await first(
      tx
        .select({ id: matchDismissals.id })
        .from(matchDismissals)
        .where(
          and(
            eq(matchDismissals.userId, userId),
            eq(matchDismissals.billId, billId),
            eq(matchDismissals.transactionId, transactionId),
          ),
        )
        .limit(1),
    );
    if (pair) throw conflict("This pair is dismissed again already.");
    await tx
      .insert(matchDismissals)
      .values({ id: entry.entityId, userId, billId, transactionId });
    return {
      action: "match_dismissal.create",
      entityId: entry.entityId,
      summary: billSummary(bill),
      after: dismissalSnapshot({ billId, transactionId }),
    };
  },
};

// --- transactions --------------------------------------------------------

type TransactionPatch = Partial<
  Pick<
    typeof transactions.$inferInsert,
    "note" | "categoryId" | "taxYear" | "deductionYear" | "deductionExcluded"
  >
>;

async function categoryExists(
  tx: Tx,
  userId: string,
  id: string,
): Promise<boolean> {
  const row = await first(
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1),
  );
  return row !== undefined;
}

function transactionBlocker(entry: ChangeEntry): string | null {
  if (entry.action !== "transaction.update") {
    return "Adding or deleting a payment cannot be reverted. Delete or re-enter it by hand.";
  }
  const keys = Object.keys(entry.after ?? {});
  const allowed: readonly string[] = REVERTIBLE_TRANSACTION_FIELDS;
  if (keys.length === 0 || keys.some((k) => !allowed.includes(k))) {
    return "Only category, note and tax changes of a payment can be reverted.";
  }
  return null;
}

const transactionHandler: RevertHandler = {
  lock: (userId) => ledgerLock(userId),
  blocker: transactionBlocker,
  async revert({ tx, userId, entry }) {
    const before = snapshotOf(entry.before, "state");
    const after = snapshotOf(entry.after, "state");
    const where = and(
      eq(transactions.userId, userId),
      eq(transactions.id, entry.entityId),
    );
    // Takes the row's write lock first; see revertBillUpdate.
    await tx
      .update(transactions)
      .set({ updatedAt: sql`${transactions.updatedAt}` })
      .where(where);
    const row = await first(
      tx
        .select({
          note: transactions.note,
          categoryId: transactions.categoryId,
          taxYear: transactions.taxYear,
          deductionYear: transactions.deductionYear,
          deductionExcluded: transactions.deductionExcluded,
          counterpartyName: transactions.counterpartyName,
          description: transactions.description,
        })
        .from(transactions)
        .where(where)
        .limit(1),
    );
    if (!row) throw conflict("The payment no longer exists.");
    assertUnchanged(row, after, "The payment");
    if (
      typeof before.categoryId === "string" &&
      !(await categoryExists(tx, userId, before.categoryId))
    ) {
      throw conflict("The category no longer exists.");
    }
    await tx
      .update(transactions)
      .set(before as TransactionPatch)
      .where(where);
    return {
      action: "transaction.update",
      entityId: entry.entityId,
      summary: transactionSummary(row),
      before: after,
      after: before,
    };
  },
};

// --- categories ----------------------------------------------------------

const toCategoryInput = (s: Snapshot): CategoryInput => ({
  name: str(s.name),
  parentId: strOrNull(s.parentId),
  kind: s.kind as CategoryKind,
  color: strOrNull(s.color),
  icon: strOrNull(s.icon) as CategoryInput["icon"],
});

async function findCategory(tx: Tx, userId: string, id: string) {
  return await first(
    tx
      .select()
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1),
  );
}

async function categoryUsage(
  tx: Tx,
  userId: string,
  id: string,
): Promise<number> {
  const counts = await Promise.all([
    countWhere(
      tx,
      categories,
      and(eq(categories.userId, userId), eq(categories.parentId, id)),
    ),
    countWhere(
      tx,
      transactions,
      and(eq(transactions.userId, userId), eq(transactions.categoryId, id)),
    ),
    countWhere(
      tx,
      categoryRules,
      and(eq(categoryRules.userId, userId), eq(categoryRules.categoryId, id)),
    ),
    countWhere(
      tx,
      budgets,
      and(eq(budgets.userId, userId), eq(budgets.categoryId, id)),
    ),
    countWhere(
      tx,
      deductionMappings,
      and(
        eq(deductionMappings.userId, userId),
        eq(deductionMappings.categoryId, id),
      ),
    ),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

async function countWhere(
  tx: Tx,
  table:
    | typeof categories
    | typeof transactions
    | typeof categoryRules
    | typeof budgets
    | typeof deductionMappings,
  where: ReturnType<typeof and>,
): Promise<number> {
  return (await first(
    tx.select({ n: count() }).from(table).where(where).limit(1),
  ))!.n;
}

interface DeletedCategory extends Snapshot {
  childIds?: string[];
  transactionIds?: string[];
  rules?: Array<
    {
      id: string;
      seq: number;
      createdAt: number;
    } & ReturnType<typeof ruleFields>
  >;
  budgets?: Array<{
    id: string;
    currency: string;
    amount: Minor;
    createdAt: number;
  }>;
  deductionMappings?: Array<{
    id: string;
    deductionType: (typeof deductionMappings.$inferInsert)["deductionType"];
    createdAt: number;
  }>;
}

const CHUNK = 400;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
}

const categoryHandler: RevertHandler = {
  lock: (userId) => categoryTreeLock(userId),
  blocker: () => null,
  async revert({ tx, userId, entry }) {
    const id = entry.entityId;
    switch (opOf(entry.action)) {
      case "create": {
        const current = await findCategory(tx, userId, id);
        if (!current) throw conflict("The category no longer exists.");
        assertUnchanged(
          categoryFields(current),
          snapshotOf(entry.after, "state"),
          "The category",
        );
        if ((await categoryUsage(tx, userId, id)) > 0) {
          throw conflict(
            "The category is in use now (payments, rules, budgets or subcategories). Undo that first.",
          );
        }
        await tx
          .delete(categories)
          .where(and(eq(categories.userId, userId), eq(categories.id, id)));
        return {
          action: "category.delete",
          entityId: id,
          summary: current.name,
          before: categoryFields(current),
        };
      }
      case "update": {
        const before = snapshotOf(entry.before, "state");
        const after = snapshotOf(entry.after, "state");
        const current = await findCategory(tx, userId, id);
        if (!current) throw conflict("The category no longer exists.");
        assertUnchanged(categoryFields(current), after, "The category");
        const input = toCategoryInput({
          ...categoryFields(current),
          ...before,
        });
        const applied = await asConflict(
          async () => await updateCategoryInTx(tx, userId, id, input),
        );
        return {
          action: "category.update",
          entityId: id,
          summary: applied.after.name,
          before: after,
          after: before,
        };
      }
      default:
        return await revertCategoryDelete({
          tx,
          userId,
          entry,
          warnings: [],
        });
    }
  },
};

async function revertCategoryDelete({
  tx,
  userId,
  entry,
}: RevertContext): Promise<Inverse> {
  const saved = snapshotOf(entry.before, "state") as DeletedCategory;
  const id = entry.entityId;
  const input = toCategoryInput(saved);
  if (await findCategory(tx, userId, id)) {
    throw conflict("A category with this id exists already.");
  }
  const clash = await first(
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.userId, userId), eq(categories.name, input.name)),
      )
      .limit(1),
  );
  if (clash) throw conflict("A category with this name exists now.");
  if (input.parentId !== null) {
    const parent = await findCategory(tx, userId, input.parentId);
    if (!parent) throw conflict("Its parent category no longer exists.");
    if (parent.parentId !== null || parent.kind !== input.kind) {
      throw conflict("Its parent category was changed since.");
    }
  }
  await tx.insert(categories).values({
    id,
    userId,
    ...input,
    createdAt: new Date(saved.createdAt as number),
  });
  for (const childId of saved.childIds ?? []) {
    const child = await findCategory(tx, userId, childId);
    if (!child) continue;
    if (child.parentId !== null) {
      throw conflict("A subcategory was moved to another parent since.");
    }
    await tx
      .update(categories)
      .set({ parentId: id })
      .where(and(eq(categories.userId, userId), eq(categories.id, childId)));
  }
  let moved = 0;
  for (const ids of chunks(saved.transactionIds ?? [])) {
    const rows = await tx
      .select({ id: transactions.id, categoryId: transactions.categoryId })
      .from(transactions)
      .where(
        and(eq(transactions.userId, userId), inArray(transactions.id, ids)),
      )
      .orderBy(asc(transactions.id));
    moved += rows.filter((r) => r.categoryId !== null).length;
    await tx
      .update(transactions)
      .set({ categoryId: id })
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, ids),
          isNull(transactions.categoryId),
        ),
      );
  }
  if (moved > 0) {
    throw conflict(
      `${plural(moved, "payment")} of this category were filed elsewhere since.`,
    );
  }
  for (const r of saved.rules ?? []) {
    await tx.insert(categoryRules).values({
      id: r.id,
      userId,
      categoryId: id,
      priority: r.priority as number,
      counterpartyContains: strOrNull(r.counterpartyContains),
      descriptionContains: strOrNull(r.descriptionContains),
      counterpartyIban: strOrNull(r.counterpartyIban),
      amountSign: strOrNull(r.amountSign) as RuleInput["amountSign"],
      seq: r.seq,
      createdAt: new Date(r.createdAt),
    });
  }
  for (const b of saved.budgets ?? []) {
    await tx.insert(budgets).values({
      id: b.id,
      userId,
      categoryId: id,
      currency: b.currency,
      amount: b.amount,
      createdAt: new Date(b.createdAt),
    });
  }
  for (const m of saved.deductionMappings ?? []) {
    await tx.insert(deductionMappings).values({
      id: m.id,
      userId,
      categoryId: id,
      deductionType: m.deductionType,
      createdAt: new Date(m.createdAt),
    });
  }
  return {
    action: "category.create",
    entityId: id,
    summary: input.name,
    after: categoryFields({ ...input }),
  };
}

// --- category rules ------------------------------------------------------

const toRuleInput = (s: Snapshot): RuleInput => ({
  categoryId: str(s.categoryId),
  priority: s.priority as number,
  counterpartyContains: strOrNull(s.counterpartyContains),
  descriptionContains: strOrNull(s.descriptionContains),
  counterpartyIban: strOrNull(s.counterpartyIban),
  amountSign: strOrNull(s.amountSign) as RuleInput["amountSign"],
});

async function findRule(tx: Tx, userId: string, id: string) {
  return await first(
    tx
      .select()
      .from(categoryRules)
      .where(and(eq(categoryRules.userId, userId), eq(categoryRules.id, id)))
      .limit(1),
  );
}

async function ruleLabel(tx: Tx, userId: string, categoryId: string) {
  return (await findCategory(tx, userId, categoryId))?.name ?? null;
}

async function revertRuleApply({
  tx,
  userId,
  entry,
}: RevertContext): Promise<Inverse> {
  const saved = snapshotOf(entry.after, "state") as {
    byCategory?: Record<string, string[]>;
  };
  const byCategory = saved.byCategory ?? {};
  let total = 0;
  let changed = 0;
  const targets: string[] = [];
  for (const [categoryId, ids] of Object.entries(byCategory)) {
    for (const part of chunks(ids)) {
      const rows = await tx
        .select({ id: transactions.id, categoryId: transactions.categoryId })
        .from(transactions)
        .where(
          and(eq(transactions.userId, userId), inArray(transactions.id, part)),
        )
        .orderBy(asc(transactions.id));
      total += part.length;
      for (const r of rows) {
        if (r.categoryId === categoryId) targets.push(r.id);
        else changed++;
      }
    }
  }
  if (changed > 0) {
    throw conflict(
      `${plural(changed, "payment")} of ${total} were filed differently since. Revert refused so that those edits are not lost.`,
    );
  }
  for (const part of chunks(targets)) {
    await tx
      .update(transactions)
      .set({ categoryId: null })
      .where(
        and(eq(transactions.userId, userId), inArray(transactions.id, part)),
      );
  }
  return {
    action: "category_rule.apply",
    entityId: "*",
    summary: `Uncategorized ${plural(targets.length, "transaction")}`,
    before: { categorized: targets.length, byCategory },
    after: { categorized: 0, byCategory: {} },
  };
}

const ruleHandler: RevertHandler = {
  lock: (userId, entry) =>
    entry.action === "category_rule.apply"
      ? ledgerLock(userId)
      : categoryTreeLock(userId),
  blocker: () => null,
  async revert(ctx) {
    const { tx, userId, entry } = ctx;
    const id = entry.entityId;
    if (entry.action === "category_rule.apply") {
      return await revertRuleApply(ctx);
    }
    switch (opOf(entry.action)) {
      case "create": {
        const current = await findRule(tx, userId, id);
        if (!current) throw conflict("The rule no longer exists.");
        assertUnchanged(
          ruleFields(current),
          snapshotOf(entry.after, "state"),
          "The rule",
        );
        await tx
          .delete(categoryRules)
          .where(
            and(eq(categoryRules.userId, userId), eq(categoryRules.id, id)),
          );
        return {
          action: "category_rule.delete",
          entityId: id,
          summary: await ruleLabel(tx, userId, current.categoryId),
          before: ruleFields(current),
        };
      }
      case "update": {
        const before = snapshotOf(entry.before, "state");
        const after = snapshotOf(entry.after, "state");
        const current = await findRule(tx, userId, id);
        if (!current) throw conflict("The rule no longer exists.");
        assertUnchanged(ruleFields(current), after, "The rule");
        const input = toRuleInput({ ...ruleFields(current), ...before });
        const applied = await asConflict(
          async () => await updateRuleInTx(tx, userId, id, input),
        );
        return {
          action: "category_rule.update",
          entityId: id,
          summary: await ruleLabel(tx, userId, applied.after.categoryId),
          before: after,
          after: before,
        };
      }
      default: {
        const saved = snapshotOf(entry.before, "state");
        if (await findRule(tx, userId, id)) {
          throw conflict("A rule with this id exists already.");
        }
        const input = toRuleInput(saved);
        if (!(await categoryExists(tx, userId, input.categoryId))) {
          throw conflict("The rule's category no longer exists.");
        }
        await tx.insert(categoryRules).values({
          ...input,
          id,
          userId,
          ...(typeof saved.seq === "number" ? { seq: saved.seq } : {}),
          ...(typeof saved.createdAt === "number"
            ? { createdAt: new Date(saved.createdAt) }
            : {}),
        });
        return {
          action: "category_rule.create",
          entityId: id,
          summary: await ruleLabel(tx, userId, input.categoryId),
          after: ruleFields(input),
        };
      }
    }
  },
};

/** Keyed by entity type (the part of the action before the dot). */
export const HANDLERS: Readonly<Record<string, RevertHandler>> = {
  bill: billHandler,
  allocation: allocationHandler,
  match_dismissal: dismissalHandler,
  transaction: transactionHandler,
  category: categoryHandler,
  category_rule: ruleHandler,
};
