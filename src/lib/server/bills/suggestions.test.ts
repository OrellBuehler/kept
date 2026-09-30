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

const payment = (
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
  return { u, account: seedAccount(u.id) };
}

describe("auto matching", () => {
  useTestDB();

  it("confirms an exact reference match as an auto allocation, once", async () => {
    const { u, account } = await setup();
    const bill = qrBill(u.id);
    const tx = payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    expect(runAutoMatching(u.id).matched).toBe(1);
    expect(runAutoMatching(u.id).matched).toBe(0);
    expect(listBillAllocations(u.id, bill.id)).toEqual([
      expect.objectContaining({
        amount: 10000,
        origin: "auto",
        transaction: expect.objectContaining({ id: tx.id }),
      }),
    ]);
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("paid");
    expect(getSuggestions(u.id)).toEqual([]);
  });

  it("allocates only the bill's remaining amount of a larger payment", async () => {
    const { u, account } = await setup();
    const bill = qrBill(u.id, { amount: minor(4000) });
    payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    runAutoMatching(u.id);
    expect(billView(u.id, bill.id, { today: TODAY })).toMatchObject({
      status: "paid",
      settled: 4000,
    });
  });

  it("does not auto-confirm IBAN+amount matches, but suggests them", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    expect(runAutoMatching(u.id).matched).toBe(0);
    const s = getSuggestions(u.id);
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
    qrBill(u.id);
    payment(u.id, account.id, 5000, { reference: EXAMPLE_QRR });
    payment(u.id, account.id, 5000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2026-09-12",
    });
    expect(runAutoMatching(u.id).matched).toBe(0);
    const s = getSuggestions(u.id);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.ambiguous && !x.auto)).toBe(true);
  });

  it("ignores cancelled and already paid bills", async () => {
    const { u, account } = await setup();
    const bill = qrBill(u.id);
    payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const { cancelBill } = await import("./bills");
    cancelBill(u.id, bill.id);
    expect(runAutoMatching(u.id).matched).toBe(0);
    expect(getSuggestions(u.id)).toEqual([]);
  });

  it("only looks at transactions near the open bills", async () => {
    const { u, account } = await setup();
    qrBill(u.id, { issueDate: "2026-09-01", dueDate: "2026-10-01" });
    payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2026-06-01",
    });
    expect(getSuggestions(u.id)).toEqual([]);
    payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2026-07-15",
    });
    expect(getSuggestions(u.id)).toHaveLength(1);
  });

  it("considers every transaction when an open bill has no dates", async () => {
    const { u, account } = await setup();
    qrBill(u.id, { issueDate: null, dueDate: null });
    payment(u.id, account.id, 10000, {
      reference: EXAMPLE_QRR,
      bookingDate: "2020-01-01",
    });
    expect(runAutoMatching(u.id).matched).toBe(1);
  });
});

describe("dismissals", () => {
  useTestDB();

  it("hide a suggestion for good and do not affect others", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    const other = payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
      bookingDate: "2026-09-11",
    });
    expect(getSuggestions(u.id)).toHaveLength(2);
    dismissSuggestion(u.id, bill.id, tx.id);
    dismissSuggestion(u.id, bill.id, tx.id);
    const left = getSuggestions(u.id);
    expect(left.map((s) => s.transactionId)).toEqual([other.id]);
    // Shared ambiguity with the dismissed pair keeps it from auto-confirming.
    expect(left[0]).toMatchObject({ ambiguous: true, auto: false });
    expect(getSuggestions(u.id, { billId: "nope" })).toEqual([]);
  });

  it("a dismissed reference match is not auto-confirmed", async () => {
    const { u, account } = await setup();
    const bill = qrBill(u.id);
    const tx = payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    dismissSuggestion(u.id, bill.id, tx.id);
    expect(runAutoMatching(u.id).matched).toBe(0);
  });
});

describe("suggestions across users", () => {
  useTestDB();

  it("never match or expose another user's data", async () => {
    const a = await setup();
    const b = await setup();
    const billA = qrBill(a.u.id);
    const txB = payment(b.u.id, b.account.id, 10000, {
      reference: EXAMPLE_QRR,
    });
    const txA = payment(a.u.id, a.account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    expect(runAutoMatching(a.u.id).matched).toBe(0);
    expect(runAutoMatching(b.u.id).matched).toBe(0);
    expect(getSuggestions(b.u.id)).toEqual([]);

    const dismiss = (user: string, bill: string, tx: string) => {
      try {
        dismissSuggestion(user, bill, tx);
      } catch (e) {
        if (e instanceof LedgerError) return e.code;
        throw e;
      }
      return "ok";
    };
    expect(dismiss(b.u.id, billA.id, txA.id)).toBe("not_found");
    expect(dismiss(a.u.id, billA.id, txB.id)).toBe("not_found");
    expect(() =>
      allocate(a.u.id, billA.id, txB.id, minor(10000), "user"),
    ).toThrow(LedgerError);
  });
});

describe("auto matching guards", () => {
  useTestDB();

  it("keeps a partial reference payment as a suggestion", async () => {
    const { u, account } = await setup();
    const bill = qrBill(u.id);
    const tx = payment(u.id, account.id, 4000, { reference: EXAMPLE_QRR });
    const result = runAutoMatching(u.id);
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
    const bill = qrBill(u.id, { amount: null });
    payment(u.id, account.id, 4321, { reference: EXAMPLE_QRR });
    const result = runAutoMatching(u.id);
    expect(result).toMatchObject({ matched: 1, suggestions: [] });
    expect(listBillAllocations(u.id, bill.id)[0]).toMatchObject({
      amount: 4321,
    });
  });

  it("returns the remaining suggestions from the same run", async () => {
    const { u, account } = await setup();
    qrBill(u.id);
    payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const other = seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
      amount: minor(777),
    });
    const tx = payment(u.id, account.id, 777, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    const r = runAutoMatching(u.id);
    expect(r.matched).toBe(1);
    expect(r.suggestions.map((s) => [s.billId, s.transactionId])).toEqual([
      [other.id, tx.id],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("reports when the transaction window hit its cap", async () => {
    const { u, account } = await setup();
    qrBill(u.id, { issueDate: null, dueDate: null });
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
      getDB()
        .insert(transactions)
        .values(rows.slice(i, i + 500))
        .run();
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(runAutoMatching(u.id).truncated).toBe(true);
    expect(warn).toHaveBeenCalledWith("suggestion window truncated");
    warn.mockRestore();
  });
});

describe("dismissals and removal", () => {
  useTestDB();

  it("removing an auto-confirmed allocation dismisses it so it does not come back", async () => {
    const { u, account } = await setup();
    const bill = qrBill(u.id);
    const tx = payment(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    runAutoMatching(u.id);
    removeAllocation(u.id, listBillAllocations(u.id, bill.id)[0]!.id);
    expect(listDismissed(u.id, bill.id).map((t) => t.id)).toEqual([tx.id]);
    expect(runAutoMatching(u.id).matched).toBe(0);
  });

  it("removing a manual allocation does not dismiss a pair that was never automatic", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = payment(u.id, account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    const { id } = allocate(u.id, bill.id, tx.id, minor(10000), "user");
    removeAllocation(u.id, id);
    expect(listDismissed(u.id, bill.id)).toEqual([]);
    expect(getSuggestions(u.id).map((s) => s.transactionId)).toEqual([tx.id]);
  });

  it("allocating a dismissed pair clears the dismissal", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const tx = payment(u.id, account.id, 10000);
    dismissSuggestion(u.id, bill.id, tx.id);
    expect(listDismissed(u.id, bill.id)).toHaveLength(1);
    allocate(u.id, bill.id, tx.id, minor(10000), "user");
    expect(listDismissed(u.id, bill.id)).toEqual([]);
  });

  it("undismiss brings the suggestion back; other users cannot undismiss", async () => {
    const a = await setup();
    const b = await setup();
    const bill = seedBill(a.u.id, {
      creditorIban: EXAMPLE_IBAN,
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
    });
    const tx = payment(a.u.id, a.account.id, 10000, {
      counterpartyIban: EXAMPLE_IBAN,
    });
    dismissSuggestion(a.u.id, bill.id, tx.id);
    expect(getSuggestions(a.u.id)).toEqual([]);
    expect(() => undismissSuggestion(b.u.id, bill.id, tx.id)).toThrow(
      LedgerError,
    );
    expect(() => listDismissed(b.u.id, bill.id)).toThrow(LedgerError);
    expect(getSuggestions(a.u.id)).toEqual([]);
    undismissSuggestion(a.u.id, bill.id, tx.id);
    undismissSuggestion(a.u.id, bill.id, tx.id);
    expect(getSuggestions(a.u.id)).toHaveLength(1);
  });
});
