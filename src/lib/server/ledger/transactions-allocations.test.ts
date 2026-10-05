import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedAccount } from "$lib/testing/ledger";
import { allocate, listBillAllocations } from "$lib/server/bills/allocations";
import { billView } from "$lib/server/bills/status";
import { billAllocations, getDB } from "$lib/server/db";
import { LedgerError } from "./errors";
import {
  createManualTransaction,
  deleteTransaction,
  getTransaction,
  updateTransaction,
} from "./transactions";

useTestDB();

const TODAY = "2026-10-01";

const input = (amount: number, note: string | null = null) => ({
  bookingDate: "2026-03-10",
  valueDate: null,
  amount: minor(amount),
  counterpartyName: null,
  counterpartyIban: null,
  description: null,
  reference: null,
  note,
});

async function setup() {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const bill = await seedBill(user.id);
  const payment = await createManualTransaction(
    user.id,
    account.id,
    input(-10000),
  );
  await allocate(user.id, bill.id, payment.id, minor(10000), "user");
  return { user, account, bill, payment };
}

const rejects = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LedgerError);
  expect((err as LedgerError).code).toBe("conflict");
  expect((err as LedgerError).message).toMatch(/allocated/i);
};

describe("editing a manual payment that is allocated to a bill", () => {
  it("rejects shrinking it below what is allocated", async () => {
    const { user, bill, payment } = await setup();
    await rejects(updateTransaction(user.id, payment.id, input(-4000)));
    expect((await getTransaction(user.id, payment.id)).amount).toBe(-10000);
    expect((await billView(user.id, bill.id, { today: TODAY })).status).toBe(
      "paid",
    );
  });

  it("rejects flipping the sign", async () => {
    const { user, payment } = await setup();
    await rejects(updateTransaction(user.id, payment.id, input(10000)));
    expect((await getTransaction(user.id, payment.id)).amount).toBe(-10000);
  });

  it("allows the same, a larger or an exactly covering amount and note edits", async () => {
    const { user, payment } = await setup();
    await updateTransaction(user.id, payment.id, input(-10000, "same"));
    await updateTransaction(user.id, payment.id, input(-15000));
    const edited = await updateTransaction(user.id, payment.id, input(-10000));
    expect(edited.amount).toBe(-10000);
  });

  it("still lets an already over-allocated payment change other fields", async () => {
    const { user, payment } = await setup();
    await getDB()
      .update(billAllocations)
      .set({ amount: minor(12000) })
      .where(eq(billAllocations.transactionId, payment.id));
    const edited = await updateTransaction(user.id, payment.id, {
      ...input(-10000),
      description: "changed",
    });
    expect(edited.description).toBe("changed");
    await rejects(updateTransaction(user.id, payment.id, input(-11000)));
  });

  it("counts the sum of all allocations of the payment", async () => {
    const { user, account } = await setup();
    const a = await seedBill(user.id, { amount: minor(3000) });
    const b = await seedBill(user.id, { amount: minor(2000) });
    const payment = await createManualTransaction(
      user.id,
      account.id,
      input(-5000),
    );
    await allocate(user.id, a.id, payment.id, minor(3000), "user");
    await allocate(user.id, b.id, payment.id, minor(2000), "user");
    await rejects(updateTransaction(user.id, payment.id, input(-4999)));
    await updateTransaction(user.id, payment.id, input(-5000));
  });

  it("a concurrent allocation and edit never leave the payment over-allocated", async () => {
    for (let delay = 0; delay <= 6; delay++) {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      const a = await seedBill(user.id, { amount: minor(6000) });
      const b = await seedBill(user.id, { amount: minor(4000) });
      const payment = await createManualTransaction(
        user.id,
        account.id,
        input(-10000),
      );
      await allocate(user.id, a.id, payment.id, minor(6000), "user");
      const edit = async () => {
        for (let i = 0; i < delay; i++) await Promise.resolve();
        await updateTransaction(user.id, payment.id, input(-6000));
      };
      await Promise.allSettled([
        allocate(user.id, b.id, payment.id, minor(4000), "user"),
        edit(),
      ]);
      const allocated =
        (await listBillAllocations(user.id, a.id)).reduce(
          (sum, x) => sum + x.amount,
          0,
        ) +
        (await listBillAllocations(user.id, b.id)).reduce(
          (sum, x) => sum + x.amount,
          0,
        );
      const { amount } = await getTransaction(user.id, payment.id);
      expect(allocated, `delay ${delay}`).toBeLessThanOrEqual(Math.abs(amount));
    }
  });

  it("is unaffected by another user's allocations", async () => {
    const mine = await setup();
    const other = await setup();
    const free = await createManualTransaction(
      other.user.id,
      other.account.id,
      input(-2000),
    );
    expect(
      (await updateTransaction(other.user.id, free.id, input(-1000))).amount,
    ).toBe(-1000);
    await expect(
      updateTransaction(other.user.id, mine.payment.id, input(-4000)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await getTransaction(mine.user.id, mine.payment.id)).amount).toBe(
      -10000,
    );
  });

  it("deleting it removes its allocations and reopens the bill", async () => {
    const { user, bill, payment } = await setup();
    await deleteTransaction(user.id, payment.id);
    expect(await listBillAllocations(user.id, bill.id)).toEqual([]);
    expect((await billView(user.id, bill.id, { today: TODAY })).status).toBe(
      "open",
    );
  });
});
