import { describe, expect, it, vi } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { LedgerError } from "$lib/server/ledger/errors";
import { allocate, listBillAllocations } from "./allocations";
import { getDB, transactions } from "$lib/server/db";
import { clearEventListeners, onBillChanged } from "$lib/server/events";
import { billView } from "./status";
import {
  dismissSuggestion,
  getSuggestions,
  listDismissed,
  removeAllocation,
  runAutoMatching,
  undismissSuggestion,
} from "./suggestions";

const TODAY = "2026-10-01";

const qrBill = (userId: string, over = {}) =>
  seedBill(userId, {
    creditorIban: EXAMPLE_IBAN_OTHER,
    reference: EXAMPLE_QRR,
    referenceType: "QRR",
    issueDate: "2026-09-01",
    dueDate: "2026-10-01",
    ...over,
  });

const payment = async (
  userId: string,
  accountId: string,
  cents: number,
  over: Record<string, unknown> = {},
) =>
  seedImportedTransaction(userId, accountId, {
    amount: minor(-cents),
    bookingDate: "2026-09-10",
    ...over,
  });

async function setup() {
  const u = await createTestUser();
  return { u, account: await seedAccount(u.id) };
}

describe("auto matching", () => {
  useTestDB();

  it("confirms an exact reference match as an auto allocation, once", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id);
    const tx = await payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
    });
    expect((await runAutoMatching(u.id)).matched).toBe(1);
    expect((await runAutoMatching(u.id)).matched).toBe(0);
    expect(await listBillAllocations(u.id, bill.id)).toEqual([
      expect.objectContaining({
        amount: 10000,
        origin: "auto",
        transaction: expect.objectContaining({ id: tx.id }),
      }),
    ]);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "paid",
    );
    expect(await getSuggestions(u.id)).toEqual([]);
  });

  it("announces an automatic allocation once, after it is written", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id);
    await payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const seen: Array<[string, number]> = [];
    clearEventListeners();
    onBillChanged(async (userId, billId) => {
      seen.push([billId, (await listBillAllocations(userId, billId)).length]);
    });
    await runAutoMatching(u.id);
    await vi.waitFor(() => expect(seen).toEqual([[bill.id, 1]]));
    await runAutoMatching(u.id);
    expect(seen).toHaveLength(1);
    clearEventListeners();
  });

  it("allocates only the bill's remaining amount of a larger payment", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id, { amount: minor(4000) });
    await payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    await runAutoMatching(u.id);
    expect(await billView(u.id, bill.id, { today: TODAY })).toMatchObject({
      status: "paid",
      settled: 4000,
    });
  });

  it("does not auto-confirm IBAN+amount matches, but suggests them", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = await payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    expect((await runAutoMatching(u.id)).matched).toBe(0);
    const s = await getSuggestions(u.id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      billId: bill.id,
      transactionId: tx.id,
      rule: "iban_amount",
      auto: false,
      amount: 10000,
      bill: expect.objectContaining({
        id: bill.id,
        creditorName: "Example Supplier",
        currency: "CHF",
      }),
      transaction: expect.objectContaining({
        id: tx.id,
        accountName: "Main",
        amount: -10000,
      }),
    });
  });

  it("leaves ambiguous reference matches (instalments) to the user", async () => {
    const { u, account } = await setup();
    await qrBill(u.id);
    await payment(u.id, account.id, 5000, { reference: EXAMPLE_QRR });
    await payment(u.id, account.id, 5000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2026-09-12",
    });
    expect((await runAutoMatching(u.id)).matched).toBe(0);
    const s = await getSuggestions(u.id);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.ambiguous && !x.auto)).toBe(true);
  });

  it("ignores cancelled and already paid bills", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id);
    await payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const { cancelBill } = await import("./bills");
    await cancelBill(u.id, bill.id);
    expect((await runAutoMatching(u.id)).matched).toBe(0);
    expect(await getSuggestions(u.id)).toEqual([]);
  });

  it("only looks at transactions near the open bills", async () => {
    const { u, account } = await setup();
    await qrBill(u.id, { issueDate: "2026-09-01", dueDate: "2026-10-01" });
    await payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2026-06-01",
    });
    expect(await getSuggestions(u.id)).toEqual([]);
    await payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2026-07-15",
    });
    expect(await getSuggestions(u.id)).toHaveLength(1);
  });

  it("considers every transaction when an open bill has no dates", async () => {
    const { u, account } = await setup();
    await qrBill(u.id, { issueDate: null, dueDate: null });
    await payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2020-01-01",
    });
    expect((await runAutoMatching(u.id)).matched).toBe(1);
  });
});

describe("dismissals", () => {
  useTestDB();

  it("hide a suggestion for good and do not affect others", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = await payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    const other = await payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
      bookingDate: "2026-09-11",
    });
    expect(await getSuggestions(u.id)).toHaveLength(2);
    await dismissSuggestion(u.id, bill.id, tx.id);
    await dismissSuggestion(u.id, bill.id, tx.id);
    const left = await getSuggestions(u.id);
    expect(left.map((s) => s.transactionId)).toEqual([other.id]);
    // Shared ambiguity with the dismissed pair keeps it from auto-confirming.
    expect(left[0]).toMatchObject({ ambiguous: true, auto: false });
    expect(await getSuggestions(u.id, { billId: "nope" })).toEqual([]);
  });

  it("a dismissed reference match is not auto-confirmed", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id);
    const tx = await payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
    });
    await dismissSuggestion(u.id, bill.id, tx.id);
    expect((await runAutoMatching(u.id)).matched).toBe(0);
  });
});

describe("suggestions across users", () => {
  useTestDB();

  it("never match or expose another user's data", async () => {
    const a = await setup();
    const b = await setup();
    const billA = await qrBill(a.u.id);
    const txB = await payment(b.u.id, b.account.id, 10000, {
      reference: EXAMPLE_QRR,
    });
    const txA = await payment(a.u.id, a.account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    expect((await runAutoMatching(a.u.id)).matched).toBe(0);
    expect((await runAutoMatching(b.u.id)).matched).toBe(0);
    expect(await getSuggestions(b.u.id)).toEqual([]);

    const dismiss = async (user: string, bill: string, tx: string) => {
      try {
        await dismissSuggestion(user, bill, tx);
      } catch (e) {
        if (e instanceof LedgerError) return e.code;
        throw e;
      }
      return "ok";
    };
    expect(await dismiss(b.u.id, billA.id, txA.id)).toBe("not_found");
    expect(await dismiss(a.u.id, billA.id, txB.id)).toBe("not_found");
    await expect(
      allocate(a.u.id, billA.id, txB.id, minor(10000), "user"),
    ).rejects.toThrow(LedgerError);
  });
});

describe("auto matching guards", () => {
  useTestDB();

  it("keeps a partial reference payment as a suggestion", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id);
    const tx = await payment(u.id, account.id, 4000, {
      reference: EXAMPLE_QRR,
    });
    const result = await runAutoMatching(u.id);
    expect(result.matched).toBe(0);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        billId: bill.id,
        transactionId: tx.id,
        rule: "reference",
        ambiguous: false,
        auto: false,
        amount: 4000,
      }),
    ]);
  });

  it("auto-confirms an open-amount bill with a single reference match", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id, { amount: null });
    await payment(u.id, account.id, 4321, { reference: EXAMPLE_QRR });
    const result = await runAutoMatching(u.id);
    expect(result).toMatchObject({ matched: 1, suggestions: [] });
    expect((await listBillAllocations(u.id, bill.id))[0]).toMatchObject({
      amount: 4321,
    });
  });

  it("returns the remaining suggestions from the same run", async () => {
    const { u, account } = await setup();
    await qrBill(u.id);
    await payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const other = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
      amount: minor(777),
    });
    const tx = await payment(u.id, account.id, 777, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    const r = await runAutoMatching(u.id);
    expect(r.matched).toBe(1);
    expect(r.suggestions.map((s) => [s.billId, s.transactionId])).toEqual([
      [other.id, tx.id],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("reports when the transaction window hit its cap", async () => {
    const { u, account } = await setup();
    await qrBill(u.id, { issueDate: null, dueDate: null });
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      userId: u.id,
      accountId: account.id,
      source: "import" as const,
      externalId: `bulk-${i}`,
      bookingDate: "2026-09-10",
      amount: minor(-100),
      currency: "CHF",
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await getDB()
        .insert(transactions)
        .values(rows.slice(i, i + 500));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await runAutoMatching(u.id)).truncated).toBe(true);
    expect(warn).toHaveBeenCalledWith("suggestion window truncated");
    warn.mockRestore();
  });
});

describe("dismissals and removal", () => {
  useTestDB();

  it("removing an auto-confirmed allocation dismisses it so it does not come back", async () => {
    const { u, account } = await setup();
    const bill = await qrBill(u.id);
    const tx = await payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
    });
    await runAutoMatching(u.id);
    await removeAllocation(
      u.id,
      (await listBillAllocations(u.id, bill.id))[0]!.id,
    );
    expect((await listDismissed(u.id, bill.id)).map((t) => t.id)).toEqual([
      tx.id,
    ]);
    expect((await runAutoMatching(u.id)).matched).toBe(0);
  });

  it("removing a manual allocation does not dismiss a pair that was never automatic", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = await payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    const { id } = await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    await removeAllocation(u.id, id);
    expect(await listDismissed(u.id, bill.id)).toEqual([]);
    expect((await getSuggestions(u.id)).map((s) => s.transactionId)).toEqual([
      tx.id,
    ]);
  });

  it("allocating a dismissed pair clears the dismissal", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const tx = await payment(u.id, account.id, 10000);
    await dismissSuggestion(u.id, bill.id, tx.id);
    expect(await listDismissed(u.id, bill.id)).toHaveLength(1);
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    expect(await listDismissed(u.id, bill.id)).toEqual([]);
  });

  it("undismiss brings the suggestion back; other users cannot undismiss", async () => {
    const a = await setup();
    const b = await setup();
    const bill = await seedBill(a.u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = await payment(a.u.id, a.account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    await dismissSuggestion(a.u.id, bill.id, tx.id);
    expect(await getSuggestions(a.u.id)).toEqual([]);
    await expect(undismissSuggestion(b.u.id, bill.id, tx.id)).rejects.toThrow(
      LedgerError,
    );
    await expect(listDismissed(b.u.id, bill.id)).rejects.toThrow(LedgerError);
    expect(await getSuggestions(a.u.id)).toEqual([]);
    await undismissSuggestion(a.u.id, bill.id, tx.id);
    await undismissSuggestion(a.u.id, bill.id, tx.id);
    expect(await getSuggestions(a.u.id)).toHaveLength(1);
  });
});
