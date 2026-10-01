import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { billAllocations, getDB, transactions } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  allocate,
  allocateFromInput,
  listBillAllocations,
} from "./allocations";
import {
  cancelBill,
  createBill,
  deleteBill,
  getBill,
  listBills,
  uncancelBill,
  updateBill,
} from "./bills";
import { candidateTransactions } from "./candidates";
import { billInput } from "$lib/testing/bills";
import { billView, billViews, groupBills } from "./status";
import { removeAllocation } from "./suggestions";

const TODAY = "2026-10-01";

function setup() {
  return createTestUser().then((u) => {
    const account = seedAccount(u.id);
    return { u, account };
  });
}

const pay = (userId: string, accountId: string, cents: number, over = {}) =>
  seedImportedTransaction(userId, accountId, {
    amount: minor(-cents),
    bookingDate: "2026-09-10",
    ...over,
  });

async function fails(fn: () => unknown): Promise<LedgerError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error("expected LedgerError");
}

describe("bills service", () => {
  useTestDB();

  it("creates, reads, updates, lists and deletes a bill", async () => {
    const { u, account } = await setup();
    const bill = createBill(
      u.id,
      billInput({ expectedAccountId: account.id }),
      {
        extraction: { source: "qr", warnings: ["w"] },
      },
    );
    expect(getBill(u.id, bill.id)).toMatchObject({
      creditorName: "Example Supplier",
      amount: 10000,
      cancelled: false,
      extraction: { source: "qr", warnings: ["w"] },
    });
    updateBill(u.id, bill.id, billInput({ notes: "n", amount: null }));
    expect(getBill(u.id, bill.id)).toMatchObject({
      notes: "n",
      amount: null,
      expectedAccountId: null,
    });
    expect(listBills(u.id)).toHaveLength(1);
    deleteBill(u.id, bill.id);
    expect(listBills(u.id)).toHaveLength(0);
    expect((await fails(() => getBill(u.id, bill.id))).code).toBe("not_found");
  });

  it("rejects an expected account that is not the user's", async () => {
    const { u } = await setup();
    const other = await createTestUser();
    const foreign = seedAccount(other.id);
    const e = await fails(() =>
      createBill(u.id, billInput({ expectedAccountId: foreign.id })),
    );
    expect(e.field).toBe("expectedAccountId");
  });

  it("keeps an external reference unique per user", async () => {
    const { u } = await setup();
    const ext = { externalSource: "adapter", externalRef: "r1" };
    createBill(u.id, billInput(), { external: ext });
    expect(
      (await fails(() => createBill(u.id, billInput(), { external: ext })))
        .code,
    ).toBe("conflict");
    const other = await createTestUser();
    expect(
      createBill(other.id, billInput(), { external: ext }).externalRef,
    ).toBe("r1");
    createBill(u.id, billInput());
    createBill(u.id, billInput());
  });

  it("sets the expected account to null when the account is deleted", async () => {
    const { u, account } = await setup();
    const bill = createBill(u.id, billInput({ expectedAccountId: account.id }));
    const { deleteAccount } = await import("$lib/server/ledger/accounts");
    deleteAccount(u.id, account.id);
    expect(getBill(u.id, bill.id).expectedAccountId).toBeNull();
  });

  it("cancels and uncancels", async () => {
    const { u } = await setup();
    const bill = seedBill(u.id);
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("open");
    cancelBill(u.id, bill.id);
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("cancelled");
    uncancelBill(u.id, bill.id);
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("open");
  });

  it("freezes kind and currency once payments are allocated", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const tx = pay(u.id, account.id, 4000);
    allocate(u.id, bill.id, tx.id, minor(4000), "user");
    expect(
      (
        await fails(() =>
          updateBill(u.id, bill.id, billInput({ kind: "credit_note" })),
        )
      ).field,
    ).toBe("kind");
    expect(
      (
        await fails(() =>
          updateBill(u.id, bill.id, billInput({ currency: "EUR" })),
        )
      ).field,
    ).toBe("currency");
    updateBill(u.id, bill.id, billInput({ amount: minor(5000) }));
    expect(billView(u.id, bill.id, { today: TODAY }).remaining).toBe(1000);
  });
});

describe("bill status from allocations", () => {
  useTestDB();

  it("goes open -> partially paid -> paid -> overpaid", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id, { dueDate: "2026-09-20" });
    const status = () => billView(u.id, bill.id, { today: TODAY });
    expect(status()).toMatchObject({
      status: "open",
      overdue: true,
      dueInDays: -11,
      remaining: 10000,
    });

    allocate(
      u.id,
      bill.id,
      pay(u.id, account.id, 4000).id,
      minor(4000),
      "user",
    );
    expect(status()).toMatchObject({
      status: "partially_paid",
      settled: 4000,
      remaining: 6000,
      overdue: true,
    });

    allocate(
      u.id,
      bill.id,
      pay(u.id, account.id, 6000).id,
      minor(6000),
      "user",
    );
    expect(status()).toMatchObject({
      status: "paid",
      remaining: 0,
      overdue: false,
      allocationCount: 2,
    });

    allocate(u.id, bill.id, pay(u.id, account.id, 500).id, minor(500), "user");
    expect(status().status).toBe("overpaid");
  });

  it("an overpaid invoice awaits a refund, which settles it again", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    allocate(
      u.id,
      bill.id,
      pay(u.id, account.id, 12000).id,
      minor(12000),
      "user",
    );
    const views = billViews(u.id, { today: TODAY });
    expect(
      groupBills(views, { today: TODAY }).awaitingRefund.map((v) => v.id),
    ).toEqual([bill.id]);

    const refund = seedImportedTransaction(u.id, account.id, {
      amount: minor(2000),
      bookingDate: "2026-09-20",
    });
    allocate(u.id, bill.id, refund.id, minor(-2000), "user");
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("paid");
  });

  it("a credit note is credit_due until the money arrives", async () => {
    const { u, account } = await setup();
    const note = seedBill(u.id, { kind: "credit_note", amount: minor(3000) });
    expect(billView(u.id, note.id, { today: TODAY }).status).toBe("credit_due");
    expect(
      groupBills(billViews(u.id, { today: TODAY }), { today: TODAY })
        .awaitingRefund,
    ).toHaveLength(1);

    const incoming = seedImportedTransaction(u.id, account.id, {
      amount: minor(3000),
      bookingDate: "2026-09-25",
    });
    allocate(u.id, note.id, incoming.id, minor(3000), "user");
    expect(billView(u.id, note.id, { today: TODAY }).status).toBe("paid");
    const groups = groupBills(billViews(u.id, { today: TODAY }), {
      today: TODAY,
    });
    expect(groups.awaitingRefund).toHaveLength(0);
    expect(groups.recentlyPaid).toHaveLength(1);
  });

  it("groups bills: overdue, due soon, other, recently paid, cancelled", async () => {
    const { u, account } = await setup();
    const overdue = seedBill(u.id, { dueDate: "2026-09-30" });
    const today = seedBill(u.id, { dueDate: "2026-10-01" });
    const soon = seedBill(u.id, { dueDate: "2026-10-15" });
    const later = seedBill(u.id, { dueDate: "2026-10-16" });
    const undated = seedBill(u.id);
    const paidRecent = seedBill(u.id, { amount: minor(1000) });
    const paidOld = seedBill(u.id, { amount: minor(1000) });
    const cancelled = seedBill(u.id);
    cancelBill(u.id, cancelled.id);
    allocate(
      u.id,
      paidRecent.id,
      pay(u.id, account.id, 1000, { bookingDate: "2026-09-02" }).id,
      minor(1000),
      "user",
    );
    allocate(
      u.id,
      paidOld.id,
      pay(u.id, account.id, 1000, { bookingDate: "2026-08-30" }).id,
      minor(1000),
      "user",
    );

    const g = groupBills(billViews(u.id, { today: TODAY }), { today: TODAY });
    const ids = (l: { id: string }[]) => l.map((v) => v.id);
    expect(ids(g.overdue)).toEqual([overdue.id]);
    expect(ids(g.dueSoon)).toEqual([today.id, soon.id]);
    expect(ids(g.openOther)).toEqual([later.id, undated.id]);
    expect(ids(g.recentlyPaid)).toEqual([paidRecent.id]);
    expect(ids(g.cancelled)).toEqual([cancelled.id]);
    expect(
      [
        ...g.overdue,
        ...g.dueSoon,
        ...g.openOther,
        ...g.recentlyPaid,
        ...g.cancelled,
      ].some((v) => v.id === paidOld.id),
    ).toBe(false);
  });

  it("deleting the transaction (import undo) drops the allocation and reopens the bill", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const tx = pay(u.id, account.id, 10000);
    allocate(u.id, bill.id, tx.id, minor(10000), "user");
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("paid");
    getDB().delete(transactions).where(eq(transactions.id, tx.id)).run();
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("open");
    expect(getDB().select().from(billAllocations).all()).toHaveLength(0);
  });

  it("deleting the account reopens the bill too", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    allocate(
      u.id,
      bill.id,
      pay(u.id, account.id, 10000).id,
      minor(10000),
      "user",
    );
    const { deleteAccount } = await import("$lib/server/ledger/accounts");
    deleteAccount(u.id, account.id);
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("open");
  });
});

describe("allocations", () => {
  useTestDB();

  it("surfaces validation errors as field errors", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const tx = pay(u.id, account.id, 4000);
    expect(
      (await fails(() => allocate(u.id, bill.id, tx.id, minor(5000), "user")))
        .field,
    ).toBe("amount");
    expect(
      (await fails(() => allocate(u.id, bill.id, tx.id, minor(0), "user")))
        .message,
    ).toMatch(/zero/);
    expect(
      (await fails(() => allocate(u.id, bill.id, tx.id, minor(-100), "user")))
        .code,
    ).toBe("invalid");
    const incoming = seedImportedTransaction(u.id, account.id, {
      amount: minor(500),
    });
    expect(
      (
        await fails(() =>
          allocate(u.id, bill.id, incoming.id, minor(500), "user"),
        )
      ).code,
    ).toBe("invalid");
    const eur = pay(u.id, account.id, 100, { currency: "EUR" });
    expect(
      (await fails(() => allocate(u.id, bill.id, eur.id, minor(100), "user")))
        .message,
    ).toMatch(/Currency/);
    cancelBill(u.id, bill.id);
    expect(
      (await fails(() => allocate(u.id, bill.id, tx.id, minor(4000), "user")))
        .message,
    ).toMatch(/cancelled/);
  });

  it("splits one payment across bills and rejects over-allocation", async () => {
    const { u, account } = await setup();
    const a = seedBill(u.id);
    const b = seedBill(u.id);
    const tx = pay(u.id, account.id, 10000);
    allocate(u.id, a.id, tx.id, minor(6000), "user");
    expect(
      (await fails(() => allocate(u.id, b.id, tx.id, minor(5000), "user")))
        .message,
    ).toMatch(/unallocated/);
    allocate(u.id, b.id, tx.id, minor(4000), "user");
    expect(
      (await fails(() => allocate(u.id, b.id, tx.id, minor(1), "user"))).code,
    ).toBe("conflict");
  });

  it("parses typed amounts in the bill's currency", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const tx = pay(u.id, account.id, 4050);
    allocateFromInput(u.id, bill.id, tx.id, "40.50", "user");
    expect(listBillAllocations(u.id, bill.id)[0]).toMatchObject({
      amount: 4050,
      origin: "user",
    });
    expect(
      (
        await fails(() =>
          allocateFromInput(u.id, bill.id, tx.id, "abc", "user"),
        )
      ).field,
    ).toBe("amount");
  });

  it("lists allocations with transaction and account display data", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const tx = pay(u.id, account.id, 1000, {
      counterpartyName: "Sample Payee",
    });
    allocate(u.id, bill.id, tx.id, minor(1000), "auto");
    expect(listBillAllocations(u.id, bill.id)).toEqual([
      expect.objectContaining({
        amount: 1000,
        origin: "auto",
        transaction: expect.objectContaining({
          id: tx.id,
          accountName: "Main",
          counterpartyName: "Sample Payee",
          amount: -1000,
        }),
      }),
    ]);
  });

  it("removing an allocation reopens the bill and dismisses the pair", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    const tx = pay(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const { runAutoMatching, getSuggestions } = await import("./suggestions");
    expect(runAutoMatching(u.id).matched).toBe(1);
    const [alloc] = listBillAllocations(u.id, bill.id);
    removeAllocation(u.id, alloc!.id);
    expect(billView(u.id, bill.id, { today: TODAY }).status).toBe("open");
    expect(runAutoMatching(u.id).matched).toBe(0);
    expect(getSuggestions(u.id)).toEqual([]);
    expect((await fails(() => removeAllocation(u.id, alloc!.id))).code).toBe(
      "not_found",
    );
    expect(tx.id).toBeDefined();
  });

  it("cannot cross users", async () => {
    const a = await setup();
    const b = await setup();
    const billA = seedBill(a.u.id);
    const billB = seedBill(b.u.id);
    const txA = pay(a.u.id, a.account.id, 1000);
    const txB = pay(b.u.id, b.account.id, 1000);
    expect(
      (
        await fails(() =>
          allocate(b.u.id, billA.id, txB.id, minor(1000), "user"),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await fails(() =>
          allocate(b.u.id, billB.id, txA.id, minor(1000), "user"),
        )
      ).code,
    ).toBe("not_found");
    const ok = allocate(a.u.id, billA.id, txA.id, minor(1000), "user");
    expect(listBills(b.u.id).map((x) => x.id)).toEqual([billB.id]);
    expect((await fails(() => removeAllocation(b.u.id, ok.id))).code).toBe(
      "not_found",
    );
    expect((await fails(() => getBill(b.u.id, billA.id))).code).toBe(
      "not_found",
    );
    expect((await fails(() => cancelBill(b.u.id, billA.id))).code).toBe(
      "not_found",
    );
    expect((await fails(() => deleteBill(b.u.id, billA.id))).code).toBe(
      "not_found",
    );
    expect(
      (await fails(() => updateBill(b.u.id, billA.id, billInput()))).code,
    ).toBe("not_found");
    expect(billViews(b.u.id, { today: TODAY })).toHaveLength(1);
    expect(getBill(a.u.id, billA.id).id).toBe(billA.id);
  });
});

describe("candidateTransactions", () => {
  useTestDB();

  it("offers same-currency, right-direction transactions with something left", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const fit = pay(u.id, account.id, 10000, {
      counterpartyName: "Sample Payee",
    });
    pay(u.id, account.id, 500, { currency: "EUR" });
    seedImportedTransaction(u.id, account.id, { amount: minor(700) });
    const used = pay(u.id, account.id, 300);
    const other = seedBill(u.id);
    allocate(u.id, other.id, used.id, minor(300), "user");

    const page = candidateTransactions(u.id, bill.id);
    expect(page.items.map((i) => i.id).sort()).toEqual([fit.id]);
    expect(page.items[0]).toMatchObject({
      unallocated: -10000,
      suggestedAmount: 10000,
      accountName: "Main",
    });
  });

  it("includes partly allocated rows with their remainder and hides rows already on the bill", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id, { amount: minor(3000) });
    const other = seedBill(u.id);
    const tx = pay(u.id, account.id, 10000);
    allocate(u.id, other.id, tx.id, minor(7000), "user");
    const item = candidateTransactions(u.id, bill.id).items[0]!;
    expect(item).toMatchObject({
      id: tx.id,
      unallocated: -3000,
      suggestedAmount: 3000,
    });
    allocate(u.id, bill.id, tx.id, minor(3000), "user");
    expect(candidateTransactions(u.id, bill.id).items).toEqual([]);
  });

  it("offers incoming payments for credit notes, and refunds for paid invoices", async () => {
    const { u, account } = await setup();
    const note = seedBill(u.id, { kind: "credit_note", amount: minor(2000) });
    const incoming = seedImportedTransaction(u.id, account.id, {
      amount: minor(2000),
    });
    const outgoing = pay(u.id, account.id, 2000);
    expect(candidateTransactions(u.id, note.id).items.map((i) => i.id)).toEqual(
      [incoming.id],
    );

    const inv = seedBill(u.id, { amount: minor(5000) });
    expect(candidateTransactions(u.id, inv.id).items.map((i) => i.id)).toEqual([
      outgoing.id,
    ]);
    allocate(
      u.id,
      inv.id,
      pay(u.id, account.id, 5000, { bookingDate: "2026-09-01" }).id,
      minor(5000),
      "user",
    );
    expect(candidateTransactions(u.id, inv.id).items.map((i) => i.id)).toEqual([
      outgoing.id,
    ]);
  });

  it("offers refunds (the surplus) only while an invoice is overpaid", async () => {
    const { u, account } = await setup();
    const incoming = seedImportedTransaction(u.id, account.id, {
      amount: minor(2000),
    });
    const inv = seedBill(u.id, { amount: minor(5000) });
    expect(candidateTransactions(u.id, inv.id).items).toEqual([]);

    const payment = pay(u.id, account.id, 5000, { bookingDate: "2026-09-01" });
    allocate(u.id, inv.id, payment.id, minor(5000), "user");
    expect(
      candidateTransactions(u.id, inv.id).items.map((i) => i.id),
    ).not.toContain(incoming.id);

    const over = seedBill(u.id, { amount: minor(5000) });
    const big = pay(u.id, account.id, 7000, { bookingDate: "2026-09-02" });
    allocate(u.id, over.id, big.id, minor(7000), "user");
    const refund = candidateTransactions(u.id, over.id).items.find(
      (i) => i.id === incoming.id,
    )!;
    expect(refund.suggestedAmount).toBe(-2000);
  });

  it("searches counterparty, description, reference and amount, and paginates", async () => {
    const { u, account } = await setup();
    const bill = seedBill(u.id);
    const a = pay(u.id, account.id, 1234, { counterpartyName: "Alpha Corp" });
    const b = pay(u.id, account.id, 5000, {
      description: "Invoice 100% paid_now",
    });
    const c = pay(u.id, account.id, 777, { reference: "REF-XYZ" });
    const ids = (q: string) =>
      candidateTransactions(u.id, bill.id, { q }).items.map((i) => i.id);
    expect(ids("alpha")).toEqual([a.id]);
    expect(ids("100%")).toEqual([b.id]);
    expect(ids("_")).toEqual([b.id]);
    expect(ids("xyz")).toEqual([c.id]);
    expect(ids("12.34")).toEqual([a.id]);
    expect(ids("nothing")).toEqual([]);

    for (let i = 0; i < 25; i++) pay(u.id, account.id, 100 + i);
    const p2 = candidateTransactions(u.id, bill.id, { page: 2 });
    expect(p2).toMatchObject({ total: 28, pageCount: 2, page: 2 });
    expect(p2.items).toHaveLength(8);
    expect(candidateTransactions(u.id, bill.id, { page: 99 }).page).toBe(2);
  });

  it("never shows another user's transactions or bills", async () => {
    const a = await setup();
    const b = await setup();
    const billA = seedBill(a.u.id);
    pay(b.u.id, b.account.id, 1000);
    expect(candidateTransactions(a.u.id, billA.id).items).toEqual([]);
    expect(() => candidateTransactions(b.u.id, billA.id)).toThrow(LedgerError);
  });
});
