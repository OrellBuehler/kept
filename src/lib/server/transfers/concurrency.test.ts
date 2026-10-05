/**
 * Linking transfers reads what is booked and then writes links, so overlapping
 * runs of one user take turns on a transaction lock. SQLite runs transactions one
 * at a time anyway; on PostgreSQL the lock is all that keeps two runs from
 * planning the same link. The lock tests hold it from another transaction and
 * expect the operation to wait.
 */
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { getDB, transactions, transfers } from "$lib/server/db";
import { confirmImport } from "$lib/server/imports/confirm";
import { undoImport } from "$lib/server/imports/history";
import { createAccount, updateAccount } from "$lib/server/ledger/accounts";
import {
  createManualTransaction,
  updateTransaction,
} from "$lib/server/ledger/transactions";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { uploadFixture } from "$lib/testing/imports";
import { expectHeldBy } from "$lib/testing/locks";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  enableFill,
  linkManually,
  linkNeedsAmountTo,
  linkTransfers,
  resolveNeedsAmount,
  unlink,
} from "./index";

useTestDB();

describe("transfers", () => {
  it("links each transfer once when overlapping linking runs plan the same links", async () => {
    const user = await createTestUser();
    const main = await seedAccount(user.id, {
      name: "Main",
      iban: EXAMPLE_IBAN,
    });
    await seedAccount(user.id, {
      name: "Savings",
      type: "savings",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    for (let i = 0; i < 6; i++) {
      await seedImportedTransaction(user.id, main.id, {
        bookingDate: `2026-03-${10 + i}`,
        amount: minor(-10000 - i),
        counterpartyIban: EXAMPLE_IBAN_OTHER,
      });
    }
    const runs = await Promise.allSettled(
      Array.from({ length: 4 }, () => linkTransfers(user.id)),
    );
    expect(runs.filter((r) => r.status === "rejected")).toEqual([]);
    const linked = await getDB()
      .select({ n: count() })
      .from(transfers)
      .where(eq(transfers.userId, user.id));
    expect(linked[0]!.n).toBe(6);
    const mirrors = await getDB()
      .select({ n: count() })
      .from(transactions)
      .where(eq(transactions.userId, user.id));
    // six sources and six mirrors
    expect(mirrors[0]!.n).toBe(12);
  });

  describe("take the user's ledger lock", () => {
    async function setup() {
      const user = await createTestUser();
      const main = await seedAccount(user.id, {
        name: "Main",
        iban: EXAMPLE_IBAN,
      });
      const savings = await seedAccount(user.id, {
        name: "Savings",
        type: "savings",
        iban: EXAMPLE_IBAN_OTHER,
      });
      const key = `ledger:${user.id}`;
      return { user, main, savings, key };
    }

    it("linkTransfers", async () => {
      const { user, key } = await setup();
      await expectHeldBy(key, () => linkTransfers(user.id));
    });

    it("createManualTransaction and updateTransaction", async () => {
      const { user, main, key } = await setup();
      const input = {
        bookingDate: "2026-03-01",
        valueDate: null,
        amount: minor(-500),
        counterpartyName: null,
        counterpartyIban: null,
        description: null,
        reference: null,
        note: null,
      };
      await expectHeldBy(key, () =>
        createManualTransaction(user.id, main.id, input),
      );
      const created = await createManualTransaction(user.id, main.id, input);
      await expectHeldBy(key, () =>
        updateTransaction(user.id, created.id, input),
      );
    });

    it("createAccount and updateAccount", async () => {
      const { user, main, key } = await setup();
      const input = {
        institutionId: null,
        name: "Another",
        type: "current" as const,
        currency: "CHF",
        iban: null,
        contractNumber: null,
        depositIban: null,
        openingBalance: minor(0),
        openingDate: null,
        noticeMonths: null,
        freeWithdrawal: null,
        freeWithdrawalPeriod: null,
        shareBps: 10000,
        sharedWith: null,
        sortOrder: null,
        fillFromTransfers: false,
        tradesMoveCash: false,
      };
      await expectHeldBy(key, () => createAccount(user.id, input));
      await expectHeldBy(key, () =>
        updateAccount(user.id, main.id, { ...input, name: "Renamed" }),
      );
    });

    it("confirmImport and undoImport", async () => {
      const { user, main, key } = await setup();
      const pending = await uploadFixture(
        user.id,
        main.id,
        "camt053/overlap-a.xml",
      );
      let confirmed: { importId: string } | undefined;
      await expectHeldBy(key, async () => {
        confirmed = await confirmImport(user.id, pending);
      });
      await expectHeldBy(key, () => undoImport(user.id, confirmed!.importId));
    });

    it("linkManually, unlink, enableFill and resolveNeedsAmount", async () => {
      const { user, main, savings, key } = await setup();
      const out = await seedImportedTransaction(user.id, main.id, {
        bookingDate: "2026-03-10",
        amount: minor(-10000),
      });
      const into = await seedImportedTransaction(user.id, savings.id, {
        bookingDate: "2026-03-10",
        amount: minor(10000),
      });
      let transferId = "";
      await expectHeldBy(key, async () => {
        transferId = await linkManually(user.id, out.id, into.id);
      });
      await expectHeldBy(key, () => unlink(user.id, transferId));
      await expectHeldBy(key, () => enableFill(user.id, savings.id));
      // Not a transfer that needs an amount: the lock is taken before that is checked.
      await expectHeldBy(key, async () => {
        await resolveNeedsAmount(user.id, transferId, minor(1)).catch(
          () => undefined,
        );
      });
      await expectHeldBy(key, async () => {
        await linkNeedsAmountTo(user.id, transferId, into.id).catch(
          () => undefined,
        );
      });
    });
  });
});
