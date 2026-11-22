/**
 * Reverts racing each other and racing ordinary edits. A revert compares the
 * data with what the entry left behind and then writes; on PostgreSQL another
 * transaction can commit in between unless the revert takes the lock the
 * writers take (or a row lock). SQLite runs writers one at a time, so these
 * only make sense on PostgreSQL.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { billInput, seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { getBill, updateBill } from "$lib/server/bills/bills";
import {
  assignCategory,
  createCategory,
  updateCategory,
} from "$lib/server/categories/categories";
import {
  applyRulesToUncategorized,
  createRule,
  listRules,
  updateRule,
} from "$lib/server/categories/rules";
import { bills, getDB, transaction, transactions } from "$lib/server/db";
import { dialect } from "$lib/server/db/dialect";
import { listChanges } from "./list";
import { revertChange } from "./revert";
import { RevertError } from "./types";

useTestDB();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cat = (name: string) => ({
  name,
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
});

const rule = (categoryId: string, priority = 100) => ({
  categoryId,
  priority,
  counterpartyContains: "grocer",
  descriptionContains: null,
  counterpartyIban: null,
  amountSign: null,
});

const newest = async (userId: string) =>
  (await listChanges(userId, { limit: 1 })).items[0]!;

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

/** Runs `run` while another transaction holds uncommitted `hold` writes, then commits that one. */
async function whileHeld<T>(
  hold: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const holder = transaction(async () => {
    await hold();
    entered();
    await gate;
  });
  await inside;
  const running = run();
  running.catch(() => undefined);
  try {
    await sleep(300);
  } finally {
    release();
    await holder;
  }
  return await running;
}

async function exactlyOne(a: Promise<unknown>, b: Promise<unknown>) {
  const settled = await Promise.allSettled([a, b]);
  expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
  const failed = settled.find((s) => s.status === "rejected") as
    PromiseRejectedResult | undefined;
  expect(failed!.reason).toBeInstanceOf(RevertError);
}

describe.skipIf(dialect !== "pg")("reverts on PostgreSQL", () => {
  describe("two reverts of the same entry", () => {
    it("a bill update: exactly one succeeds", async () => {
      const u = await createTestUser();
      const bill = await seedBill(u.id, { notes: "first" });
      await updateBill(u.id, bill.id, billInput({ notes: "second" }));
      const edit = await newest(u.id);
      await exactlyOne(
        revertChange(u.id, edit.id),
        revertChange(u.id, edit.id),
      );
      expect((await getBill(u.id, bill.id)).notes).toBe("first");
    });

    it("applying the rules: exactly one succeeds", async () => {
      const u = await createTestUser();
      const account = await seedAccount(u.id);
      const food = await createCategory(u.id, cat("Food"));
      await createRule(u.id, rule(food.id));
      await seedImportedTransaction(u.id, account.id, {
        counterpartyName: "Example Grocer",
      });
      await applyRulesToUncategorized(u.id);
      const applied = await newest(u.id);
      await exactlyOne(
        revertChange(u.id, applied.id),
        revertChange(u.id, applied.id),
      );
    });

    it("a category rename: exactly one succeeds", async () => {
      const u = await createTestUser();
      const food = await createCategory(u.id, cat("Food"));
      await updateCategory(u.id, food.id, cat("Groceries"));
      const rename = await newest(u.id);
      await exactlyOne(
        revertChange(u.id, rename.id),
        revertChange(u.id, rename.id),
      );
    });
  });

  describe("a revert racing an ordinary edit", () => {
    it("a bill update: the later edit is never lost", async () => {
      for (let round = 0; round < 5; round++) {
        const u = await createTestUser();
        const bill = await seedBill(u.id, { notes: "first" });
        await updateBill(u.id, bill.id, billInput({ notes: "second" }));
        const edit = await newest(u.id);
        await Promise.allSettled([
          revertChange(u.id, edit.id),
          updateBill(u.id, bill.id, billInput({ notes: "third" })),
        ]);
        expect((await getBill(u.id, bill.id)).notes).toBe("third");
      }
    });

    it("a bill update: refuses when a writer outside the bills lock committed first", async () => {
      const u = await createTestUser();
      const bill = await seedBill(u.id, { notes: "first" });
      await updateBill(u.id, bill.id, billInput({ notes: "second" }));
      const edit = await newest(u.id);
      const outcome = await whileHeld(
        async () => {
          await getDB()
            .update(bills)
            .set({ notes: "third" })
            .where(eq(bills.id, bill.id));
        },
        () => refusal(revertChange(u.id, edit.id)),
      );
      expect(outcome).toBeInstanceOf(RevertError);
      expect((await getBill(u.id, bill.id)).notes).toBe("third");
    });

    it("a rule edit: the later edit is never lost", async () => {
      for (let round = 0; round < 5; round++) {
        const u = await createTestUser();
        const food = await createCategory(u.id, cat("Food"));
        const made = await createRule(u.id, rule(food.id));
        await updateRule(u.id, made.id, rule(food.id, 5));
        const edit = await newest(u.id);
        await Promise.allSettled([
          revertChange(u.id, edit.id),
          updateRule(u.id, made.id, rule(food.id, 7)),
        ]);
        expect((await listRules(u.id))[0]!.priority).toBe(7);
      }
    });

    it("applying the rules: a payment filed meanwhile keeps its category", async () => {
      for (let round = 0; round < 5; round++) {
        const u = await createTestUser();
        const account = await seedAccount(u.id);
        const food = await createCategory(u.id, cat("Food"));
        const other = await createCategory(u.id, cat("Other"));
        await createRule(u.id, rule(food.id));
        const payment = await seedImportedTransaction(u.id, account.id, {
          counterpartyName: "Example Grocer",
        });
        await applyRulesToUncategorized(u.id);
        const applied = await newest(u.id);
        await Promise.allSettled([
          revertChange(u.id, applied.id),
          assignCategory(u.id, payment.id, other.id),
        ]);
        const [row] = await getDB()
          .select()
          .from(transactions)
          .where(eq(transactions.id, payment.id));
        expect(row!.categoryId).toBe(other.id);
      }
    });

    it("applying the rules: refuses when a payment was filed between its read and its write", async () => {
      const u = await createTestUser();
      const account = await seedAccount(u.id);
      const food = await createCategory(u.id, cat("Food"));
      const other = await createCategory(u.id, cat("Other"));
      await createRule(u.id, rule(food.id));
      const payment = await seedImportedTransaction(u.id, account.id, {
        counterpartyName: "Example Grocer",
      });
      await applyRulesToUncategorized(u.id);
      const applied = await newest(u.id);
      // The new category is uncommitted while the revert reads, so the revert
      // sees the old one and its write has to wait for the row.
      const outcome = await whileHeld(
        async () => {
          await getDB()
            .update(transactions)
            .set({ categoryId: other.id })
            .where(eq(transactions.id, payment.id));
        },
        () => refusal(revertChange(u.id, applied.id)),
      );
      expect(outcome).toBeInstanceOf(RevertError);
      const [row] = await getDB()
        .select()
        .from(transactions)
        .where(eq(transactions.id, payment.id));
      expect(row!.categoryId).toBe(other.id);
    });
  });
});
