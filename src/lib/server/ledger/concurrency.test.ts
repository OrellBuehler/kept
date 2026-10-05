/**
 * An account's currency is checked against the rows that pin it (transactions,
 * balances, trades) in other transactions, and removing an account or a
 * transaction races the writers that reference them. All of it takes the one
 * per-user ledger lock; the tests hold it from another transaction and expect
 * each operation to wait.
 */
import { describe, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount } from "$lib/testing/ledger";
import { expectHeldBy } from "$lib/testing/locks";
import { deleteAccount, setAccountArchived } from "./accounts";
import { createSnapshot } from "./snapshots";
import { createManualTransaction, deleteTransaction } from "./transactions";

useTestDB();

describe("ledger", () => {
  it("adding a balance takes the user's ledger lock", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    await expectHeldBy(`ledger:${user.id}`, () =>
      createSnapshot(user.id, account.id, {
        date: "2026-01-31",
        amount: minor(100),
        note: null,
      }),
    );
  });

  it("deleting a manual transaction takes the ledger lock", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const key = `ledger:${user.id}`;
    const manual = await createManualTransaction(user.id, account.id, {
      bookingDate: "2026-03-01",
      valueDate: null,
      amount: minor(-500),
      counterpartyName: null,
      counterpartyIban: null,
      description: null,
      reference: null,
      note: null,
    });
    await expectHeldBy(key, () => deleteTransaction(user.id, manual.id));
  });

  it("archiving, unarchiving and deleting an account take the ledger lock", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const key = `ledger:${user.id}`;
    await expectHeldBy(key, () =>
      setAccountArchived(user.id, account.id, true),
    );
    await expectHeldBy(key, () =>
      setAccountArchived(user.id, account.id, false),
    );
    await expectHeldBy(key, () => deleteAccount(user.id, account.id));
  });
});
