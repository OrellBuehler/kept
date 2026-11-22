import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { billInput, seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { expectHeldBy } from "$lib/testing/locks";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { allocate, listBillAllocations } from "$lib/server/bills/allocations";
import {
  attachDocument,
  cancelBill,
  createBill,
  deleteBill,
  getBill,
  listBills,
  uncancelBill,
  updateBill,
  billsLock,
} from "$lib/server/bills/bills";
import {
  dismissSuggestion,
  removeAllocation,
  runAutoMatching,
  undismissSuggestion,
} from "$lib/server/bills/suggestions";
import {
  assignCategory,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "$lib/server/categories/categories";
import { createBudget, listBudgets } from "$lib/server/categories/budgets";
import {
  applyRulesToUncategorized,
  createRule,
  deleteRule,
  listRules,
  updateRule,
} from "$lib/server/categories/rules";
import {
  billAllocations,
  bills,
  getDB,
  matchDismissals,
  transaction,
  transactions,
} from "$lib/server/db";
import { setCategoryDeduction } from "$lib/server/tax/deductions";
import { updateTransaction } from "$lib/server/ledger/transactions";
import { ledgerLock } from "$lib/server/ledger/lock";
import { runAsActor } from "./context";
import { getChange, listChanges } from "./list";
import { isRevertible, revertChange, revertChanges } from "./revert";
import { RevertError, type ChangeEntry } from "./types";

useTestDB();

const newest = async (userId: string): Promise<ChangeEntry> =>
  (await listChanges(userId, { limit: 1 })).items[0]!;

const all = async (userId: string) =>
  (await listChanges(userId, { limit: 200 })).items;

const cat = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
  ...over,
});

const rule = (categoryId: string, over: Record<string, unknown> = {}) => ({
  categoryId,
  priority: 100,
  counterpartyContains: "grocer",
  descriptionContains: null,
  counterpartyIban: null,
  amountSign: null,
  ...over,
});

async function refused(
  promise: Promise<unknown>,
  reason: RevertError["reason"],
): Promise<RevertError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RevertError);
  expect((err as RevertError).reason).toBe(reason);
  return err as RevertError;
}

describe("revert: bills", () => {
  it("undoes a create by deleting the bill, and logs that as its own entry", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, { creditorName: "Example Supplier" });
    const created = await newest(u.id);
    expect(created).toMatchObject({
      action: "bill.create",
      entityType: "bill",
      entityId: bill.id,
      summary: "Example Supplier",
      before: null,
    });
    expect(created.after).toMatchObject({
      creditorName: "Example Supplier",
      amount: 10000,
      currency: "CHF",
    });
    expect(isRevertible(created)).toBe(true);

    const result = await revertChange(u.id, created.id);
    expect(await listBills(u.id)).toEqual([]);
    expect(result.entry).toMatchObject({
      action: "bill.delete",
      entityId: bill.id,
      revertOfEntryId: created.id,
    });
    expect(result.reverted).toMatchObject({
      id: created.id,
      revertedByEntryId: result.entry.id,
    });
    expect(result.reverted.revertedAt).not.toBeNull();
    expect(isRevertible(result.reverted)).toBe(false);
    expect(isRevertible(result.entry)).toBe(false);
  });

  it("undoes an update field by field and leaves later edits of other fields alone", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, {
      notes: "first",
      dueDate: "2026-10-01",
    });
    await updateBill(
      u.id,
      bill.id,
      billInput({ notes: "second", dueDate: "2026-10-01" }),
    );
    const notesEdit = await newest(u.id);
    expect(notesEdit).toMatchObject({
      action: "bill.update",
      before: { notes: "first" },
      after: { notes: "second" },
    });
    await updateBill(
      u.id,
      bill.id,
      billInput({ notes: "second", dueDate: "2026-11-30" }),
    );
    await revertChange(u.id, notesEdit.id);
    const now = await getBill(u.id, bill.id);
    expect(now.notes).toBe("first");
    expect(now.dueDate).toBe("2026-11-30");
  });

  it("refuses an update whose fields were changed since, naming the fields only", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, { notes: "first" });
    await updateBill(u.id, bill.id, billInput({ notes: "second" }));
    const edit = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "third" }));
    const err = await refused(revertChange(u.id, edit.id), "conflict");
    expect(err.message).toContain("notes");
    expect(err.message).not.toContain("third");
    expect((await getBill(u.id, bill.id)).notes).toBe("third");
    expect((await getChange(u.id, edit.id)).revertedAt).toBeNull();
  });

  it("does not log an update that changed nothing", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    const before = (await all(u.id)).length;
    await updateBill(u.id, bill.id, billInput());
    expect((await all(u.id)).length).toBe(before);
  });

  it("undoes cancelling and uncancelling", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    await cancelBill(u.id, bill.id);
    const cancel = await newest(u.id);
    expect(cancel).toMatchObject({
      action: "bill.cancel",
      before: { cancelled: false },
      after: { cancelled: true },
    });
    const undone = await revertChange(u.id, cancel.id);
    expect(undone.entry.action).toBe("bill.uncancel");
    expect((await getBill(u.id, bill.id)).cancelled).toBe(false);
    await cancelBill(u.id, bill.id);
    await uncancelBill(u.id, bill.id);
    const uncancel = await newest(u.id);
    expect(uncancel.action).toBe("bill.uncancel");
    expect((await revertChange(u.id, uncancel.id)).entry.action).toBe(
      "bill.cancel",
    );
    expect((await getBill(u.id, bill.id)).cancelled).toBe(true);
  });

  it("does not log cancelling a bill that is cancelled already", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    await cancelBill(u.id, bill.id);
    const n = (await all(u.id)).length;
    await cancelBill(u.id, bill.id);
    expect((await all(u.id)).length).toBe(n);
  });

  it("will not change the type or currency once payments are matched", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id);
    await updateBill(u.id, bill.id, billInput({ currency: "EUR" }));
    const edit = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ currency: "CHF" }));
    const back = await newest(u.id);
    const tx = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
    });
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    await refused(revertChange(u.id, back.id), "conflict");
    expect((await getBill(u.id, bill.id)).currency).toBe("CHF");
    expect(edit.action).toBe("bill.update");
  });

  it("recreates a deleted bill with its id, dates and matched payments", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id, { creditorName: "Gone Ltd", notes: "n" });
    const paid = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
    });
    const other = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-500),
    });
    const allocation = await allocate(
      u.id,
      bill.id,
      paid.id,
      minor(10000),
      "user",
    );
    await dismissSuggestion(u.id, bill.id, other.id);
    const original = await getBill(u.id, bill.id);

    await deleteBill(u.id, bill.id);
    const deletion = await newest(u.id);
    expect(deletion.action).toBe("bill.delete");
    expect(deletion.after).toBeNull();
    expect(deletion.before).toMatchObject({
      creditorName: "Gone Ltd",
      allocations: [
        { id: allocation.id, transactionId: paid.id, amount: 10000 },
      ],
    });
    expect(await listBills(u.id)).toEqual([]);

    const result = await revertChange(u.id, deletion.id);
    expect(result.warnings).toEqual([]);
    expect(result.entry.action).toBe("bill.create");
    const restored = await getBill(u.id, bill.id);
    expect({ ...restored, updatedAt: 0 }).toEqual({
      ...original,
      updatedAt: 0,
    });
    const [a] = await listBillAllocations(u.id, bill.id);
    expect(a).toMatchObject({ id: allocation.id, amount: 10000 });
    const dismissed = await getDB()
      .select()
      .from(matchDismissals)
      .where(eq(matchDismissals.billId, bill.id));
    expect(dismissed.map((d) => d.transactionId)).toEqual([other.id]);
  });

  it("recreates a deleted bill and reports a payment that is gone", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id);
    const paid = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
    });
    await allocate(u.id, bill.id, paid.id, minor(10000), "user");
    await deleteBill(u.id, bill.id);
    const deletion = await newest(u.id);
    await getDB().delete(transactions).where(eq(transactions.id, paid.id));
    const result = await revertChange(u.id, deletion.id);
    expect(result.warnings).toHaveLength(1);
    expect(await listBillAllocations(u.id, bill.id)).toEqual([]);
    expect((await getBill(u.id, bill.id)).id).toBe(bill.id);
  });

  it("refuses to undo a create after payments were matched, and undoes both newest first", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id);
    const created = await newest(u.id);
    const tx = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
    });
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    const matched = await newest(u.id);
    expect(matched.action).toBe("allocation.create");

    await refused(revertChange(u.id, created.id), "conflict");
    expect((await getBill(u.id, bill.id)).id).toBe(bill.id);

    const batch = await revertChanges(u.id, [created.id, matched.id]);
    expect(batch.stoppedAt).toBeNull();
    expect(batch.results.map((r) => r.reverted.id)).toEqual([
      matched.id,
      created.id,
    ]);
    expect(await listBills(u.id)).toEqual([]);
  });

  it("refuses to undo a create of a bill that was edited since", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, { notes: "a" });
    const created = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "b" }));
    await refused(revertChange(u.id, created.id), "conflict");
    expect((await getBill(u.id, bill.id)).notes).toBe("b");
  });

  it("logs nothing when attaching a document fails", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id);
    await expect(attachDocument(u.id, bill.id, "nope")).rejects.toThrow();
    expect((await all(u.id)).map((e) => e.action)).toEqual(["bill.create"]);
  });

  it("ignores the address an integration rewrote when the document server moved", async () => {
    const u = await createTestUser();
    const bill = await createBill(u.id, billInput(), {
      external: {
        externalSource: "docs",
        externalRef: "7",
        externalUrl: "https://old.example.org/doc/7",
      },
    });
    const created = await newest(u.id);
    expect(created.after).toMatchObject({
      externalUrl: "https://old.example.org/doc/7",
    });
    await getDB()
      .update(bills)
      .set({ externalUrl: "https://new.example.org/doc/7" })
      .where(eq(bills.id, bill.id));
    await revertChange(u.id, created.id);
    expect(await listBills(u.id)).toEqual([]);
  });

  it("reverts a bill create under the bills lock", async () => {
    const u = await createTestUser();
    await seedBill(u.id);
    const created = await newest(u.id);
    await expectHeldBy(billsLock(u.id).lock, () =>
      revertChange(u.id, created.id),
    );
  });
});

describe("revert: matched payments", () => {
  async function paidBill() {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    const tx = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
      reference: EXAMPLE_QRR,
    });
    return { u, account, bill, tx };
  }

  it("undoes a manual match and puts the payment back as open", async () => {
    const { u, bill, tx } = await paidBill();
    const a = await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    const entry = await newest(u.id);
    expect(entry).toMatchObject({
      action: "allocation.create",
      entityId: a.id,
      after: {
        billId: bill.id,
        transactionId: tx.id,
        amount: 10000,
        origin: "user",
      },
    });
    const result = await revertChange(u.id, entry.id);
    expect(result.entry.action).toBe("allocation.delete");
    expect(await listBillAllocations(u.id, bill.id)).toEqual([]);
  });

  it("undoes an automatic match and dismisses the pair so it is not made again", async () => {
    const { u, bill } = await paidBill();
    expect((await runAutoMatching(u.id)).matched).toBe(1);
    const entry = await newest(u.id);
    expect(entry.action).toBe("allocation.auto_match");
    const result = await revertChange(u.id, entry.id);
    expect(result.entry).toMatchObject({
      action: "allocation.delete",
      after: { dismissedPair: true },
    });
    expect((await runAutoMatching(u.id)).matched).toBe(0);
    expect(await listBillAllocations(u.id, bill.id)).toEqual([]);
  });

  it("brings back a removed match with its id, also when the removal dismissed the pair", async () => {
    const { u, bill, tx } = await paidBill();
    await runAutoMatching(u.id);
    const [existing] = await listBillAllocations(u.id, bill.id);
    await removeAllocation(u.id, existing!.id);
    const removal = await newest(u.id);
    expect(removal).toMatchObject({
      action: "allocation.delete",
      entityId: existing!.id,
      after: { dismissedPair: true },
    });
    const result = await revertChange(u.id, removal.id);
    expect(result.entry.action).toBe("allocation.create");
    const [back] = await listBillAllocations(u.id, bill.id);
    expect(back).toMatchObject({ id: existing!.id, origin: "auto" });
    const dismissals = await getDB()
      .select()
      .from(matchDismissals)
      .where(eq(matchDismissals.transactionId, tx.id));
    expect(dismissals).toEqual([]);
  });

  it("refuses to bring a match back when the payment is taken elsewhere", async () => {
    const { u, bill, tx } = await paidBill();
    const other = await seedBill(u.id);
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    const [a] = await listBillAllocations(u.id, bill.id);
    await removeAllocation(u.id, a!.id);
    const removal = await newest(u.id);
    await allocate(u.id, other.id, tx.id, minor(10000), "user");
    await refused(revertChange(u.id, removal.id), "conflict");
    expect(await listBillAllocations(u.id, bill.id)).toEqual([]);
  });

  it("refuses to undo a match that was removed already", async () => {
    const { u, bill, tx } = await paidBill();
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    const entry = await newest(u.id);
    const [a] = await listBillAllocations(u.id, bill.id);
    await removeAllocation(u.id, a!.id);
    await refused(revertChange(u.id, entry.id), "conflict");
  });

  it("undoes dismissing and undismissing a suggestion", async () => {
    const { u, bill, tx } = await paidBill();
    await dismissSuggestion(u.id, bill.id, tx.id);
    const dismiss = await newest(u.id);
    expect(dismiss.action).toBe("match_dismissal.create");
    await revertChange(u.id, dismiss.id);
    expect(await getDB().select().from(matchDismissals)).toEqual([]);

    await dismissSuggestion(u.id, bill.id, tx.id);
    await undismissSuggestion(u.id, bill.id, tx.id);
    const undismiss = await newest(u.id);
    expect(undismiss.action).toBe("match_dismissal.delete");
    await revertChange(u.id, undismiss.id);
    expect(await getDB().select().from(matchDismissals)).toHaveLength(1);
  });

  it("does not log dismissing a pair twice or undismissing one that is not dismissed", async () => {
    const { u, bill, tx } = await paidBill();
    const base = (await all(u.id)).length;
    await undismissSuggestion(u.id, bill.id, tx.id);
    expect(await all(u.id)).toHaveLength(base);
    await dismissSuggestion(u.id, bill.id, tx.id);
    await dismissSuggestion(u.id, bill.id, tx.id);
    expect(await all(u.id)).toHaveLength(base + 1);
  });
});

describe("revert: payments", () => {
  async function paymentWorld() {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const groceries = await createCategory(u.id, cat("Groceries"));
    const tx = await seedImportedTransaction(u.id, account.id, {
      counterpartyName: "Example Grocer",
    });
    return { u, account, groceries, tx };
  }

  it("undoes a category assignment", async () => {
    const { u, groceries, tx } = await paymentWorld();
    await assignCategory(u.id, tx.id, groceries.id);
    const entry = await newest(u.id);
    expect(entry).toMatchObject({
      action: "transaction.update",
      entityType: "transaction",
      entityId: tx.id,
      summary: "Example Grocer",
      before: { categoryId: null },
      after: { categoryId: groceries.id },
    });
    await revertChange(u.id, entry.id);
    const [row] = await getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.id, tx.id));
    expect(row!.categoryId).toBeNull();
  });

  it("refuses when the payment was filed elsewhere since", async () => {
    const { u, groceries, tx } = await paymentWorld();
    const other = await createCategory(u.id, cat("Other"));
    await assignCategory(u.id, tx.id, groceries.id);
    const entry = await newest(u.id);
    await assignCategory(u.id, tx.id, other.id);
    await refused(revertChange(u.id, entry.id), "conflict");
    const [row] = await getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.id, tx.id));
    expect(row!.categoryId).toBe(other.id);
  });

  it("refuses to restore a category that was deleted", async () => {
    const { u, groceries, tx } = await paymentWorld();
    await assignCategory(u.id, tx.id, groceries.id);
    await assignCategory(u.id, tx.id, null);
    const clear = await newest(u.id);
    expect(clear.before).toEqual({ categoryId: groceries.id });
    await deleteCategory(u.id, groceries.id);
    await refused(revertChange(u.id, clear.id), "conflict");
  });

  it("undoes a note on an imported payment", async () => {
    const { u, tx } = await paymentWorld();
    await updateTransaction(u.id, tx.id, { note: "check this" });
    const entry = await newest(u.id);
    expect(entry).toMatchObject({
      before: { note: null },
      after: { note: "check this" },
    });
    await revertChange(u.id, entry.id);
    const [row] = await getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.id, tx.id));
    expect(row!.note).toBeNull();
  });

  it("logs edits of a manual payment but does not offer to undo what moves money", async () => {
    const { u, account } = await paymentWorld();
    const { createManualTransaction } =
      await import("$lib/server/ledger/transactions");
    const manual = await createManualTransaction(u.id, account.id, {
      bookingDate: "2026-09-01",
      valueDate: null,
      amount: minor(-500),
      counterpartyName: "Example Kiosk",
      counterpartyIban: null,
      description: null,
      reference: null,
      note: null,
    });
    const created = await newest(u.id);
    expect(created.action).toBe("transaction.create");
    expect(isRevertible(created)).toBe(false);
    await refused(revertChange(u.id, created.id), "not_revertible");

    await updateTransaction(u.id, manual.id, {
      bookingDate: "2026-09-02",
      valueDate: null,
      amount: minor(-700),
      counterpartyName: "Example Kiosk",
      counterpartyIban: null,
      description: null,
      reference: null,
      note: "later",
    });
    const edit = await newest(u.id);
    expect(edit.before).toMatchObject({
      amount: -500,
      bookingDate: "2026-09-01",
    });
    expect(edit.after).toMatchObject({
      amount: -700,
      bookingDate: "2026-09-02",
    });
    expect(isRevertible(edit)).toBe(false);
    await refused(revertChange(u.id, edit.id), "not_revertible");

    await updateTransaction(u.id, manual.id, {
      bookingDate: "2026-09-02",
      valueDate: null,
      amount: minor(-700),
      counterpartyName: "Example Kiosk",
      counterpartyIban: null,
      description: null,
      reference: null,
      note: null,
    });
    const noteOnly = await newest(u.id);
    expect(noteOnly.after).toEqual({ note: null });
    expect(isRevertible(noteOnly)).toBe(true);
  });

  it("reverts a payment edit under the ledger lock", async () => {
    const { u, groceries, tx } = await paymentWorld();
    await assignCategory(u.id, tx.id, groceries.id);
    const entry = await newest(u.id);
    await expectHeldBy(ledgerLock(u.id), () => revertChange(u.id, entry.id));
  });
});

describe("revert: categories and rules", () => {
  it("undoes creating a category only while nothing uses it", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const food = await createCategory(u.id, cat("Food"));
    const created = await newest(u.id);
    const tx = await seedImportedTransaction(u.id, account.id);
    await assignCategory(u.id, tx.id, food.id);
    await refused(revertChange(u.id, created.id), "conflict");
    await revertChanges(u.id, [created.id, (await newest(u.id)).id]);
    expect(await listCategories(u.id)).toEqual([]);
  });

  it("undoes a rename and refuses when the name is taken", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, cat("Food"));
    await updateCategory(u.id, food.id, cat("Groceries"));
    const rename = await newest(u.id);
    expect(rename).toMatchObject({
      action: "category.update",
      before: { name: "Food" },
      after: { name: "Groceries" },
    });
    await createCategory(u.id, cat("Food"));
    const err = await refused(revertChange(u.id, rename.id), "conflict");
    expect(err.message).toMatch(/already exists/);
    expect((await getCategory(u.id, food.id)).name).toBe("Groceries");
  });

  it("restores a deleted category with its rules, budgets, subcategories and payments", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const food = await createCategory(u.id, cat("Food"));
    const lunch = await createCategory(
      u.id,
      cat("Lunch", { parentId: food.id }),
    );
    const filed = await seedImportedTransaction(u.id, account.id);
    await assignCategory(u.id, filed.id, food.id);
    const r = await createRule(u.id, rule(food.id));
    const budget = await createBudget(u.id, {
      categoryId: food.id,
      currency: "CHF",
      amount: minor(20000),
    });
    await setCategoryDeduction(u.id, food.id, "donations");

    await deleteCategory(u.id, food.id);
    const deletion = await newest(u.id);
    expect(deletion.before).toMatchObject({
      name: "Food",
      childIds: [lunch.id],
      transactionIds: [filed.id],
      rules: [{ id: r.id }],
      budgets: [{ id: budget.id, amount: 20000 }],
    });
    expect(await listRules(u.id)).toEqual([]);

    const result = await revertChange(u.id, deletion.id);
    expect(result.entry.action).toBe("category.create");
    expect((await getCategory(u.id, food.id)).name).toBe("Food");
    expect((await getCategory(u.id, lunch.id)).parentId).toBe(food.id);
    expect((await listRules(u.id)).map((x) => x.id)).toEqual([r.id]);
    expect((await listBudgets(u.id)).map((b) => b.id)).toEqual([budget.id]);
    const [row] = await getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.id, filed.id));
    expect(row!.categoryId).toBe(food.id);
  });

  it("refuses to restore a deleted category when its name is taken or a payment was refiled", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const food = await createCategory(u.id, cat("Food"));
    const filed = await seedImportedTransaction(u.id, account.id);
    await assignCategory(u.id, filed.id, food.id);
    await deleteCategory(u.id, food.id);
    const deletion = await newest(u.id);
    const other = await createCategory(u.id, cat("Other"));
    await assignCategory(u.id, filed.id, other.id);
    await refused(revertChange(u.id, deletion.id), "conflict");
    expect(await listCategories(u.id)).toHaveLength(1);

    await createCategory(u.id, cat("Food"));
    await refused(revertChange(u.id, deletion.id), "conflict");
  });

  it("refuses to restore a deleted category when a subcategory changed its type since", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, cat("Food"));
    const lunch = await createCategory(
      u.id,
      cat("Lunch", { parentId: food.id }),
    );
    await deleteCategory(u.id, food.id);
    const deletion = await newest(u.id);
    await updateCategory(u.id, lunch.id, cat("Lunch", { kind: "income" }));
    const err = await refused(revertChange(u.id, deletion.id), "conflict");
    expect(err.message).toMatch(/subcategory/);
    expect(await listCategories(u.id)).toHaveLength(1);
    expect((await getCategory(u.id, lunch.id)).parentId).toBeNull();
  });

  it("undoes creating, editing and deleting a rule", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, cat("Food"));
    const made = await createRule(u.id, rule(food.id));
    const create = await newest(u.id);
    expect(create).toMatchObject({
      action: "category_rule.create",
      entityId: made.id,
      summary: "Food",
    });

    await updateRule(u.id, made.id, rule(food.id, { priority: 5 }));
    const edit = await newest(u.id);
    expect(edit).toMatchObject({
      before: { priority: 100 },
      after: { priority: 5 },
    });
    await revertChange(u.id, edit.id);
    expect((await listRules(u.id))[0]!.priority).toBe(100);

    await deleteRule(u.id, made.id);
    const removal = await newest(u.id);
    await revertChange(u.id, removal.id);
    expect((await listRules(u.id)).map((x) => x.id)).toEqual([made.id]);

    // The rule is as the create entry left it, so that can be undone too.
    await revertChange(u.id, create.id);
    expect(await listRules(u.id)).toEqual([]);
  });

  it("refuses to undo a rule edit when the rule changed since", async () => {
    const u = await createTestUser();
    const food = await createCategory(u.id, cat("Food"));
    const made = await createRule(u.id, rule(food.id));
    await updateRule(u.id, made.id, rule(food.id, { priority: 5 }));
    const edit = await newest(u.id);
    await updateRule(u.id, made.id, rule(food.id, { priority: 7 }));
    await refused(revertChange(u.id, edit.id), "conflict");
  });

  it("undoes applying the rules as one step, and refuses when a payment was refiled", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const food = await createCategory(u.id, cat("Food"));
    await createRule(u.id, rule(food.id));
    const a = await seedImportedTransaction(u.id, account.id, {
      counterpartyName: "Example Grocer",
    });
    const b = await seedImportedTransaction(u.id, account.id, {
      counterpartyName: "Example Grocer",
    });
    await applyRulesToUncategorized(u.id);
    const applied = await newest(u.id);
    expect(applied).toMatchObject({
      action: "category_rule.apply",
      after: { categorized: 2, byCategory: { [food.id]: expect.any(Array) } },
    });
    const filed = async () =>
      (await getDB().select().from(transactions)).map((t) => t.categoryId);

    await assignCategory(u.id, a.id, null);
    await assignCategory(u.id, a.id, food.id);
    expect(await filed()).toEqual([food.id, food.id]);
    await revertChange(u.id, applied.id);
    expect(await filed()).toEqual([null, null]);

    await applyRulesToUncategorized(u.id);
    const again = await newest(u.id);
    const other = await createCategory(u.id, cat("Other"));
    await assignCategory(u.id, b.id, other.id);
    const err = await refused(revertChange(u.id, again.id), "conflict");
    expect(err.message).toMatch(/1 payment of 2/);
    expect(await filed()).toContain(food.id);
  });

  it("reverts a category or rule under the category lock", async () => {
    const u = await createTestUser();
    await createCategory(u.id, cat("Food"));
    const created = await newest(u.id);
    await expectHeldBy(`categories:${u.id}`, () =>
      revertChange(u.id, created.id),
    );
  });
});

describe("revert: refusals", () => {
  it("refuses an entry twice", async () => {
    const u = await createTestUser();
    await seedBill(u.id);
    const created = await newest(u.id);
    await revertChange(u.id, created.id);
    await refused(revertChange(u.id, created.id), "already_reverted");
  });

  it("refuses the entry a revert wrote", async () => {
    const u = await createTestUser();
    await seedBill(u.id);
    const { entry } = await revertChange(u.id, (await newest(u.id)).id);
    await refused(revertChange(u.id, entry.id), "not_revertible");
  });

  it("refuses kinds of change that have no undo", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const entry = await newest(u.id);
    expect(entry.action).toBe("account.create");
    expect(isRevertible(entry)).toBe(false);
    await refused(revertChange(u.id, entry.id), "not_revertible");
    expect(account.id).toBe(entry.entityId);
  });

  it("does not know an entry that does not exist", async () => {
    const u = await createTestUser();
    await refused(revertChange(u.id, crypto.randomUUID()), "not_found");
  });

  it("never touches another user's entries or data", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const bill = await seedBill(a.id);
    const entry = await newest(a.id);
    await refused(revertChange(b.id, entry.id), "not_found");
    const batch = await revertChanges(b.id, [entry.id]);
    expect(batch.results).toEqual([]);
    expect(batch.stoppedAt?.error.reason).toBe("not_found");
    expect((await getBill(a.id, bill.id)).id).toBe(bill.id);
    expect((await getChange(a.id, entry.id)).revertedAt).toBeNull();
  });

  it("is atomic: a refused revert changes nothing and writes no entry", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, { notes: "a" });
    await updateBill(u.id, bill.id, billInput({ notes: "b" }));
    const edit = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "c" }));
    const before = (await all(u.id)).length;
    await refused(revertChange(u.id, edit.id), "conflict");
    expect((await all(u.id)).length).toBe(before);
  });
});

describe("revertChanges", () => {
  it("undoes entries newest first whatever order they are given in", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, { notes: "1" });
    const created = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "2" }));
    const e2 = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "3" }));
    const e3 = await newest(u.id);
    const batch = await revertChanges(u.id, [created.id, e2.id, e3.id]);
    expect(batch.stoppedAt).toBeNull();
    expect(batch.results.map((r) => r.reverted.id)).toEqual([
      e3.id,
      e2.id,
      created.id,
    ]);
    expect(await listBills(u.id)).toEqual([]);
  });

  it("stops at the first conflict, keeps what it already undid and reports the entry", async () => {
    const u = await createTestUser();
    const bill = await seedBill(u.id, { notes: "1" });
    const created = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "2" }));
    const e2 = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "3" }));
    const e3 = await newest(u.id);
    await updateBill(u.id, bill.id, billInput({ notes: "4" }));
    // e3 now conflicts (notes were changed after it); e4 was not asked for.
    const batch = await revertChanges(u.id, [created.id, e2.id, e3.id]);
    expect(batch.results).toEqual([]);
    expect(batch.stoppedAt).toMatchObject({ entryId: e3.id });
    expect(batch.stoppedAt?.error.reason).toBe("conflict");
    expect((await getBill(u.id, bill.id)).notes).toBe("4");
    expect((await getChange(u.id, e2.id)).revertedAt).toBeNull();
  });

  it("keeps the earlier undos when a later entry conflicts", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id);
    const created = await newest(u.id);
    const tx = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
    });
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    const matched = await newest(u.id);
    // Only the bill is asked for: it conflicts with the match that is not.
    const batch = await revertChanges(u.id, [created.id]);
    expect(batch.stoppedAt?.entryId).toBe(created.id);
    const second = await revertChanges(u.id, [matched.id]);
    expect(second.stoppedAt).toBeNull();
    expect(
      await getDB()
        .select()
        .from(billAllocations)
        .where(and(eq(billAllocations.billId, bill.id))),
    ).toEqual([]);
  });

  it("skips entries that were undone already and reports unknown ids before changing anything", async () => {
    const u = await createTestUser();
    await seedBill(u.id);
    const created = await newest(u.id);
    await revertChange(u.id, created.id);
    const skipped = await revertChanges(u.id, [created.id]);
    expect(skipped).toEqual({ results: [], stoppedAt: null });

    await seedBill(u.id);
    const fresh = await newest(u.id);
    const missing = crypto.randomUUID();
    const batch = await revertChanges(u.id, [fresh.id, missing]);
    expect(batch.stoppedAt).toMatchObject({ entryId: missing });
    expect(batch.results).toEqual([]);
    expect(await listBills(u.id)).toHaveLength(1);
  });

  it("attributes the revert to whoever reverts, not to the original actor", async () => {
    const u = await createTestUser();
    const entry = await runAsActor(
      { kind: "mcp", userId: u.id, tokenId: "c1", label: "Assistant" },
      async () => {
        await createBill(u.id, billInput());
        return await newest(u.id);
      },
    );
    expect(entry.actor.kind).toBe("mcp");
    const result = await runAsActor({ kind: "web", userId: u.id }, () =>
      revertChange(u.id, entry.id),
    );
    expect(result.entry.actor).toEqual({
      kind: "web",
      tokenId: null,
      label: null,
    });
    expect(
      (await listChanges(u.id, { actorKind: "mcp" })).items.map((e) => e.id),
    ).toEqual([entry.id]);
  });

  it("can revert everything one mcp connection changed", async () => {
    const u = await createTestUser();
    const bill = await runAsActor(
      { kind: "mcp", userId: u.id, tokenId: "c1" },
      async () => {
        const b = await createBill(u.id, billInput({ notes: "x" }));
        await updateBill(u.id, b.id, billInput({ notes: "y" }));
        return b;
      },
    );
    await seedBill(u.id);
    const theirs = (await listChanges(u.id, { tokenId: "c1" })).items;
    expect(theirs).toHaveLength(2);
    const batch = await revertChanges(
      u.id,
      theirs.map((e) => e.id),
    );
    expect(batch.stoppedAt).toBeNull();
    const left = await listBills(u.id);
    expect(left.map((b) => b.id)).not.toContain(bill.id);
    expect(left).toHaveLength(1);
  });
});

describe("a revert and the transaction around it", () => {
  it("rolls back with the surrounding transaction: no entry is left behind", async () => {
    const u = await createTestUser();
    await expect(
      transaction(async () => {
        await createBill(u.id, billInput());
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await all(u.id)).toEqual([]);
    expect(await listBills(u.id)).toEqual([]);
  });

  it("logs nothing for a change the service refused", async () => {
    const u = await createTestUser();
    await expect(
      createBill(u.id, billInput({ expectedAccountId: "not-mine" })),
    ).rejects.toThrow();
    expect(await all(u.id)).toEqual([]);
  });
});
