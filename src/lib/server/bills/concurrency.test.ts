/**
 * Allocating a payment checks the bill and every other allocation, so everything
 * that changes what those checks read takes the user's bills lock.
 */
import { describe, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { billInput, seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { updateBill } from "./bills";
import { writeAutoMatches } from "./suggestions";

useTestDB();

describe("bills", () => {
  it("updateBill and automatic matching take the user's bills lock", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id, { name: "Main" });
    const bill = await seedBill(user.id);
    const key = `bills:${user.id}`;
    await expectHeldBy(key, () =>
      updateBill(user.id, bill.id, billInput({ notes: "changed" })),
    );
    const payment = await seedImportedTransaction(user.id, account.id, {
      amount: minor(-10000),
    });
    await expectHeldBy(key, () =>
      writeAutoMatches(user.id, [
        { billId: bill.id, transactionId: payment.id },
      ]),
    );
  });
});
