import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { minor } from "$lib/money";
import { billAllocations, getDB, transactions } from "$lib/server/db";
import { clearEventListeners, onBillChanged } from "$lib/server/events";
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
  allocateInTx,
  listBillAllocations,
} from "./allocations";
import {
  cancelBill,
  createBill,
  deleteBill,
  deleteDocumentIfUnused,
  getBill,
  listBills,
  setBillExtraction,
  uncancelBill,
  updateBill,
} from "./bills";
import { getDocumentMeta, storeDocument } from "./documents";
import { candidateTransactions } from "./candidates";
import { billInput } from "$lib/testing/bills";
import { billView, billViews, groupBills } from "./status";
import { removeAllocation } from "./suggestions";

const TODAY = "2026-10-01";

function setup() {
  return createTestUser().then(async (u) => {
    const account = await seedAccount(u.id);
    return { u, account };
  });
}

const pay = async (
  userId: string,
  accountId: string,
  cents: number,
  over = {},
) =>
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
    const bill = await createBill(
      u.id,
      billInput({ expectedAccountId: account.id }),
      {
        extraction: { source: "qr", warnings: ["w"] },
      },
    );
    expect(await getBill(u.id, bill.id)).toMatchObject({
      creditorName: "Example Supplier",
      amount: 10000,
      cancelled: false,
      extraction: { source: "qr", warnings: ["w"] },
    });
    await updateBill(u.id, bill.id, billInput({ notes: "n", amount: null }));
    expect(await getBill(u.id, bill.id)).toMatchObject({
      notes: "n",
      amount: null,
      expectedAccountId: null,
    });
    expect(await listBills(u.id)).toHaveLength(1);
    await deleteBill(u.id, bill.id);
    expect(await listBills(u.id)).toHaveLength(0);
    expect((await fails(() => getBill(u.id, bill.id))).code).toBe("not_found");
  });

  it("rejects an expected account that is not the user's", async () => {
    const { u } = await setup();
    const other = await createTestUser();
    const foreign = await seedAccount(other.id);
    const e = await fails(() =>
      createBill(u.id, billInput({ expectedAccountId: foreign.id })),
    );
    expect(e.field).toBe("expectedAccountId");
  });

  it("keeps an external reference unique per user", async () => {
    const { u } = await setup();
    const ext = { externalSource: "adapter", externalRef: "r1" };
    await createBill(u.id, billInput(), { external: ext });
    expect(
      (await fails(() => createBill(u.id, billInput(), { external: ext })))
        .code,
    ).toBe("conflict");
    const other = await createTestUser();
    expect(
      (await createBill(other.id, billInput(), { external: ext })).externalRef,
    ).toBe("r1");
    await createBill(u.id, billInput());
    await createBill(u.id, billInput());
  });

  it("sets the expected account to null when the account is deleted", async () => {
    const { u, account } = await setup();
    const bill = await createBill(
      u.id,
      billInput({ expectedAccountId: account.id }),
    );
    const { deleteAccount } = await import("$lib/server/ledger/accounts");
    await deleteAccount(u.id, account.id);
    expect((await getBill(u.id, bill.id)).expectedAccountId).toBeNull();
  });

  it("cancels and uncancels", async () => {
    const { u } = await setup();
    const bill = await seedBill(u.id);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "open",
    );
    await cancelBill(u.id, bill.id);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "cancelled",
    );
    await uncancelBill(u.id, bill.id);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "open",
    );
  });

  it("freezes kind and currency once payments are allocated", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 4000);
    await allocate(u.id, bill.id, tx.id, minor(4000), "user");
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
    await updateBill(u.id, bill.id, billInput({ amount: minor(5000) }));
    expect((await billView(u.id, bill.id, { today: TODAY })).remaining).toBe(
      1000,
    );
  });
});

describe("bill status from allocations", () => {
  useTestDB();

  it("goes open -> partially paid -> paid -> overpaid", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id, { dueDate: "2026-09-20" });
    const status = () => billView(u.id, bill.id, { today: TODAY });
    expect(await status()).toMatchObject({
      status: "open",
      overdue: true,
      dueInDays: -11,
      remaining: 10000,
    });

    await allocate(
      u.id,
      bill.id,
      (await pay(u.id, account.id, 4000)).id,
      minor(4000),
      "user",
    );
    expect(await status()).toMatchObject({
      status: "partially_paid",
      settled: 4000,
      remaining: 6000,
      overdue: true,
    });

    await allocate(
      u.id,
      bill.id,
      (await pay(u.id, account.id, 6000)).id,
      minor(6000),
      "user",
    );
    expect(await status()).toMatchObject({
      status: "paid",
      remaining: 0,
      overdue: false,
      allocationCount: 2,
    });

    await allocate(
      u.id,
      bill.id,
      (await pay(u.id, account.id, 500)).id,
      minor(500),
      "user",
    );
    expect((await status()).status).toBe("overpaid");
  });

  it("an overpaid invoice awaits a refund, which settles it again", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    await allocate(
      u.id,
      bill.id,
      (await pay(u.id, account.id, 12000)).id,
      minor(12000),
      "user",
    );
    const views = await billViews(u.id, { today: TODAY });
    expect(
      groupBills(views, { today: TODAY }).awaitingRefund.map((v) => v.id),
    ).toEqual([bill.id]);

    const refund = await seedImportedTransaction(u.id, account.id, {
      amount: minor(2000),
      bookingDate: "2026-09-20",
    });
    await allocate(u.id, bill.id, refund.id, minor(-2000), "user");
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "paid",
    );
  });

  it("a credit note is credit_due until the money arrives", async () => {
    const { u, account } = await setup();
    const note = await seedBill(u.id, {
      kind: "credit_note",
      amount: minor(3000),
    });
    expect((await billView(u.id, note.id, { today: TODAY })).status).toBe(
      "credit_due",
    );
    expect(
      groupBills(await billViews(u.id, { today: TODAY }), { today: TODAY })
        .awaitingRefund,
    ).toHaveLength(1);

    const incoming = await seedImportedTransaction(u.id, account.id, {
      amount: minor(3000),
      bookingDate: "2026-09-25",
    });
    await allocate(u.id, note.id, incoming.id, minor(3000), "user");
    expect((await billView(u.id, note.id, { today: TODAY })).status).toBe(
      "paid",
    );
    const groups = groupBills(await billViews(u.id, { today: TODAY }), {
      today: TODAY,
    });
    expect(groups.awaitingRefund).toHaveLength(0);
    expect(groups.recentlyPaid).toHaveLength(1);
  });

  it("groups bills: overdue, due soon, other, recently paid, cancelled", async () => {
    const { u, account } = await setup();
    const overdue = await seedBill(u.id, { dueDate: "2026-09-30" });
    const today = await seedBill(u.id, { dueDate: "2026-10-01" });
    const soon = await seedBill(u.id, { dueDate: "2026-10-15" });
    const later = await seedBill(u.id, { dueDate: "2026-10-16" });
    const undated = await seedBill(u.id);
    const paidRecent = await seedBill(u.id, { amount: minor(1000) });
    const paidOld = await seedBill(u.id, { amount: minor(1000) });
    const cancelled = await seedBill(u.id);
    await cancelBill(u.id, cancelled.id);
    await allocate(
      u.id,
      paidRecent.id,
      (await pay(u.id, account.id, 1000, { bookingDate: "2026-09-02" })).id,
      minor(1000),
      "user",
    );
    await allocate(
      u.id,
      paidOld.id,
      (await pay(u.id, account.id, 1000, { bookingDate: "2026-08-30" })).id,
      minor(1000),
      "user",
    );

    const g = groupBills(await billViews(u.id, { today: TODAY }), {
      today: TODAY,
    });
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
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 10000);
    await allocate(u.id, bill.id, tx.id, minor(10000), "user");
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "paid",
    );
    await getDB().delete(transactions).where(eq(transactions.id, tx.id));
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "open",
    );
    expect(await getDB().select().from(billAllocations)).toHaveLength(0);
  });

  it("deleting the account reopens the bill too", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    await allocate(
      u.id,
      bill.id,
      (await pay(u.id, account.id, 10000)).id,
      minor(10000),
      "user",
    );
    const { deleteAccount } = await import("$lib/server/ledger/accounts");
    await deleteAccount(u.id, account.id);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "open",
    );
  });
});

describe("allocations", () => {
  useTestDB();

  it("surfaces validation errors as field errors", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 4000);
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
    const incoming = await seedImportedTransaction(u.id, account.id, {
      amount: minor(500),
    });
    expect(
      (
        await fails(() =>
          allocate(u.id, bill.id, incoming.id, minor(500), "user"),
        )
      ).code,
    ).toBe("invalid");
    const eur = await pay(u.id, account.id, 100, { currency: "EUR" });
    expect(
      (await fails(() => allocate(u.id, bill.id, eur.id, minor(100), "user")))
        .message,
    ).toMatch(/Currency/);
    await cancelBill(u.id, bill.id);
    expect(
      (await fails(() => allocate(u.id, bill.id, tx.id, minor(4000), "user")))
        .message,
    ).toMatch(/cancelled/);
  });

  it("splits one payment across bills and rejects over-allocation", async () => {
    const { u, account } = await setup();
    const a = await seedBill(u.id);
    const b = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 10000);
    await allocate(u.id, a.id, tx.id, minor(6000), "user");
    expect(
      (await fails(() => allocate(u.id, b.id, tx.id, minor(5000), "user")))
        .message,
    ).toMatch(/unallocated/);
    await allocate(u.id, b.id, tx.id, minor(4000), "user");
    expect(
      (await fails(() => allocate(u.id, b.id, tx.id, minor(1), "user"))).code,
    ).toBe("conflict");
  });

  it("parses typed amounts in the bill's currency", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 4050);
    await allocateFromInput(u.id, bill.id, tx.id, "40.50", "user");
    expect((await listBillAllocations(u.id, bill.id))[0]).toMatchObject({
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
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 1000, {
      counterpartyName: "Sample Payee",
    });
    await allocate(u.id, bill.id, tx.id, minor(1000), "auto");
    expect(await listBillAllocations(u.id, bill.id)).toEqual([
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
    const bill = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    const tx = await pay(u.id, account.id, 10000, { reference: EXAMPLE_QRR });
    const { runAutoMatching, getSuggestions } = await import("./suggestions");
    expect((await runAutoMatching(u.id)).matched).toBe(1);
    const [alloc] = await listBillAllocations(u.id, bill.id);
    await removeAllocation(u.id, alloc!.id);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "open",
    );
    expect((await runAutoMatching(u.id)).matched).toBe(0);
    expect(await getSuggestions(u.id)).toEqual([]);
    expect((await fails(() => removeAllocation(u.id, alloc!.id))).code).toBe(
      "not_found",
    );
    expect(tx.id).toBeDefined();
  });

  it("cannot cross users", async () => {
    const a = await setup();
    const b = await setup();
    const billA = await seedBill(a.u.id);
    const billB = await seedBill(b.u.id);
    const txA = await pay(a.u.id, a.account.id, 1000);
    const txB = await pay(b.u.id, b.account.id, 1000);
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
    const ok = await allocate(a.u.id, billA.id, txA.id, minor(1000), "user");
    expect((await listBills(b.u.id)).map((x) => x.id)).toEqual([billB.id]);
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
    expect(await billViews(b.u.id, { today: TODAY })).toHaveLength(1);
    expect((await getBill(a.u.id, billA.id)).id).toBe(billA.id);
  });
});

describe("allocateInTx", () => {
  useTestDB();

  it("allocates like allocate, from inside a transaction", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 10000);
    const created = getDB().transaction((t) =>
      allocateInTx(t, u.id, bill.id, tx.id, minor(10000), "auto"),
    );
    expect(created.id).toEqual(expect.any(String));
    expect(await listBillAllocations(u.id, bill.id)).toEqual([
      expect.objectContaining({ amount: 10000, origin: "auto" }),
    ]);
    expect((await billView(u.id, bill.id, { today: TODAY })).status).toBe(
      "paid",
    );
  });

  it("refuses the same things, and a transaction of another user is not found", async () => {
    const { u, account } = await setup();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id);
    const bill = await seedBill(u.id);
    const mine = await pay(u.id, account.id, 4000);
    const foreign = await pay(other.id, theirs.id, 4000);
    const run = (transactionId: string, amount: number) => () =>
      getDB().transaction((t) =>
        allocateInTx(t, u.id, bill.id, transactionId, minor(amount), "user"),
      );
    expect(run(mine.id, 5000)).toThrow(
      expect.objectContaining({ code: "invalid", field: "amount" }),
    );
    expect(run(foreign.id, 4000)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(await listBillAllocations(u.id, bill.id)).toEqual([]);
  });
});

describe("candidateTransactions", () => {
  useTestDB();

  it("offers same-currency, right-direction transactions with something left", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const fit = await pay(u.id, account.id, 10000, {
      counterpartyName: "Sample Payee",
    });
    await pay(u.id, account.id, 500, { currency: "EUR" });
    await seedImportedTransaction(u.id, account.id, { amount: minor(700) });
    const used = await pay(u.id, account.id, 300);
    const other = await seedBill(u.id);
    await allocate(u.id, other.id, used.id, minor(300), "user");

    const page = await candidateTransactions(u.id, bill.id);
    expect(page.items.map((i) => i.id).sort()).toEqual([fit.id]);
    expect(page.items[0]).toMatchObject({
      unallocated: -10000,
      suggestedAmount: 10000,
      accountName: "Main",
    });
  });

  it("includes partly allocated rows with their remainder and hides rows already on the bill", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id, { amount: minor(3000) });
    const other = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 10000);
    await allocate(u.id, other.id, tx.id, minor(7000), "user");
    const item = (await candidateTransactions(u.id, bill.id)).items[0]!;
    expect(item).toMatchObject({
      id: tx.id,
      unallocated: -3000,
      suggestedAmount: 3000,
    });
    await allocate(u.id, bill.id, tx.id, minor(3000), "user");
    expect((await candidateTransactions(u.id, bill.id)).items).toEqual([]);
  });

  it("offers incoming payments for credit notes, and refunds for paid invoices", async () => {
    const { u, account } = await setup();
    const note = await seedBill(u.id, {
      kind: "credit_note",
      amount: minor(2000),
    });
    const incoming = await seedImportedTransaction(u.id, account.id, {
      amount: minor(2000),
    });
    const outgoing = await pay(u.id, account.id, 2000);
    expect(
      (await candidateTransactions(u.id, note.id)).items.map((i) => i.id),
    ).toEqual([incoming.id]);

    const inv = await seedBill(u.id, { amount: minor(5000) });
    expect(
      (await candidateTransactions(u.id, inv.id)).items.map((i) => i.id),
    ).toEqual([outgoing.id]);
    await allocate(
      u.id,
      inv.id,
      (await pay(u.id, account.id, 5000, { bookingDate: "2026-09-01" })).id,
      minor(5000),
      "user",
    );
    expect(
      (await candidateTransactions(u.id, inv.id)).items.map((i) => i.id),
    ).toEqual([outgoing.id]);
  });

  it("offers refunds (the surplus) only while an invoice is overpaid", async () => {
    const { u, account } = await setup();
    const incoming = await seedImportedTransaction(u.id, account.id, {
      amount: minor(4000),
    });
    const inv = await seedBill(u.id, { amount: minor(5000) });
    expect((await candidateTransactions(u.id, inv.id)).items).toEqual([]);

    const payment = await pay(u.id, account.id, 5000, {
      bookingDate: "2026-09-01",
    });
    await allocate(u.id, inv.id, payment.id, minor(5000), "user");
    expect(
      (await candidateTransactions(u.id, inv.id)).items.map((i) => i.id),
    ).not.toContain(incoming.id);

    const over = await seedBill(u.id, { amount: minor(5000) });
    const big = await pay(u.id, account.id, 7000, {
      bookingDate: "2026-09-02",
    });
    await allocate(u.id, over.id, big.id, minor(7000), "user");
    const refund = (await candidateTransactions(u.id, over.id)).items.find(
      (i) => i.id === incoming.id,
    )!;
    expect(refund.suggestedAmount).toBe(-2000);
  });

  it("offers outgoing refunds only while a credit note is overpaid", async () => {
    const { u, account } = await setup();
    const note = await seedBill(u.id, {
      kind: "credit_note",
      amount: minor(2000),
    });
    const outgoing = await pay(u.id, account.id, 1500);
    const incoming = await seedImportedTransaction(u.id, account.id, {
      amount: minor(2000),
    });
    await allocate(u.id, note.id, incoming.id, minor(2000), "user");
    expect((await candidateTransactions(u.id, note.id)).items).toEqual([]);

    const over = await seedBill(u.id, {
      kind: "credit_note",
      amount: minor(2000),
    });
    const big = await seedImportedTransaction(u.id, account.id, {
      amount: minor(3000),
    });
    await allocate(u.id, over.id, big.id, minor(3000), "user");
    const item = (await candidateTransactions(u.id, over.id)).items.find(
      (i) => i.id === outgoing.id,
    )!;
    expect(item.suggestedAmount).toBe(-1000);
  });

  it("searches counterparty, description, reference and amount, and paginates", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const a = await pay(u.id, account.id, 1234, {
      counterpartyName: "Alpha Corp",
    });
    const b = await pay(u.id, account.id, 5000, {
      description: "Invoice 100% paid_now",
    });
    const c = await pay(u.id, account.id, 777, { reference: "REF-XYZ" });
    const ids = async (q: string) =>
      (await candidateTransactions(u.id, bill.id, { q })).items.map(
        (i) => i.id,
      );
    expect(await ids("alpha")).toEqual([a.id]);
    expect(await ids("100%")).toEqual([b.id]);
    expect(await ids("_")).toEqual([b.id]);
    expect(await ids("xyz")).toEqual([c.id]);
    expect(await ids("12.34")).toEqual([a.id]);
    expect(await ids("nothing")).toEqual([]);

    for (let i = 0; i < 25; i++) await pay(u.id, account.id, 100 + i);
    const p2 = await candidateTransactions(u.id, bill.id, { page: 2 });
    expect(p2).toMatchObject({ total: 28, pageCount: 2, page: 2 });
    expect(p2.items).toHaveLength(8);
    expect(
      (await candidateTransactions(u.id, bill.id, { page: 99 })).page,
    ).toBe(2);
  });

  it("never shows another user's transactions or bills", async () => {
    const a = await setup();
    const b = await setup();
    const billA = await seedBill(a.u.id);
    await pay(b.u.id, b.account.id, 1000);
    expect((await candidateTransactions(a.u.id, billA.id)).items).toEqual([]);
    await expect(candidateTransactions(b.u.id, billA.id)).rejects.toThrow(
      LedgerError,
    );
  });
});

describe("check-then-write", () => {
  useTestDB();

  it("two concurrent imports of one external reference create a single bill", async () => {
    const { u } = await setup();
    const ext = { externalSource: "adapter", externalRef: "race" };
    const results = await Promise.allSettled([
      createBill(u.id, billInput(), { external: ext }),
      createBill(u.id, billInput(), { external: ext }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const lost = results.find((r) => r.status === "rejected")!;
    expect((lost as PromiseRejectedResult).reason).toMatchObject({
      code: "conflict",
    });
    expect(await listBills(u.id)).toHaveLength(1);
  });

  it("does not turn other database failures into the duplicate message", async () => {
    const { u } = await setup();
    const boom = new Error("disk full");
    vi.spyOn(getDB(), "transaction").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(
      createBill(u.id, billInput(), {
        external: { externalSource: "adapter", externalRef: "x" },
      }),
    ).rejects.toBe(boom);
    vi.restoreAllMocks();
    expect(await listBills(u.id)).toHaveLength(0);
  });

  it("two concurrent allocations of one payment cannot exceed it", async () => {
    const { u, account } = await setup();
    const a = await seedBill(u.id);
    const b = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 10000);
    const results = await Promise.allSettled([
      allocate(u.id, a.id, tx.id, minor(6000), "user"),
      allocate(u.id, b.id, tx.id, minor(6000), "user"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).toMatchObject({ code: "invalid", field: "amount" });
    const total =
      (await listBillAllocations(u.id, a.id)).length +
      (await listBillAllocations(u.id, b.id)).length;
    expect(total).toBe(1);
  });

  it("announces an allocation once it is written, and not when it is refused", async () => {
    const { u, account } = await setup();
    const bill = await seedBill(u.id);
    const tx = await pay(u.id, account.id, 4000);
    const seen: number[] = [];
    clearEventListeners();
    onBillChanged(async (userId, billId) => {
      seen.push((await listBillAllocations(userId, billId)).length);
    });
    await expect(
      allocate(u.id, bill.id, tx.id, minor(5000), "user"),
    ).rejects.toThrow(LedgerError);
    await vi.waitFor(() => expect(seen).toEqual([]));
    await allocate(u.id, bill.id, tx.id, minor(4000), "user");
    await vi.waitFor(() => expect(seen).toEqual([1]));
    clearEventListeners();
  });

  it("deletes an unreferenced upload but keeps one a bill references, atomically", async () => {
    const { u } = await setup();
    const doc = await storeDocument(
      u.id,
      new TextEncoder().encode("%PDF-1.4 keep"),
      "a.pdf",
      "application/pdf",
    );
    const bill = await createBill(u.id, billInput(), { documentId: doc.id });
    expect(await deleteDocumentIfUnused(u.id, doc.id)).toBe(false);
    expect((await getDocumentMeta(u.id, doc.id)).id).toBe(doc.id);
    await deleteBill(u.id, bill.id);
    await expect(getDocumentMeta(u.id, doc.id)).rejects.toThrow(LedgerError);
    expect(await deleteDocumentIfUnused(u.id, doc.id)).toBe(false);
  });

  it("leaves another user's bills untouched by delete, cancel, update and extraction", async () => {
    const a = await setup();
    const b = await setup();
    const bill = await seedBill(a.u.id);
    await expect(deleteBill(b.u.id, bill.id)).rejects.toThrow(LedgerError);
    await expect(cancelBill(b.u.id, bill.id)).rejects.toThrow(LedgerError);
    await expect(
      updateBill(b.u.id, bill.id, billInput({ creditorName: "Hijacked" })),
    ).rejects.toThrow(LedgerError);
    await expect(
      setBillExtraction(b.u.id, bill.id, { source: "none", warnings: [] }),
    ).rejects.toThrow(LedgerError);
    expect(await listBills(b.u.id)).toEqual([]);
    expect(await getBill(a.u.id, bill.id)).toMatchObject({
      creditorName: "Example Supplier",
      cancelled: false,
      extraction: null,
    });
  });

  it("rolls the update back when the account is not the user's", async () => {
    const a = await setup();
    const b = await setup();
    const bill = await seedBill(a.u.id);
    await expect(
      updateBill(
        a.u.id,
        bill.id,
        billInput({ creditorName: "Changed", expectedAccountId: b.account.id }),
      ),
    ).rejects.toMatchObject({ field: "expectedAccountId" });
    expect((await getBill(a.u.id, bill.id)).creditorName).toBe(
      "Example Supplier",
    );
  });
});
