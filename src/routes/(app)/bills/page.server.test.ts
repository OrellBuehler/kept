import { describe, expect, it, vi } from "vitest";
import { minor } from "$lib/money";
import { onBillChanged } from "$lib/server/events";
import { billAllocations, bills, getDB, matchDismissals } from "$lib/server/db";
import { listBillAllocations } from "$lib/server/bills/allocations";
import { todayLocal } from "$lib/server/bills/dates";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
const loadAs = (user: User, search = "") =>
  outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://localhost/bills${search}`,
      }) as never,
    ),
  );
const run = (
  name: keyof typeof actions,
  user: User,
  form: Record<string, string>,
) => outcome(() => actions[name]!(createTestEvent({ user, form }) as never));

const daysFromToday = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayLocal(d);
};

describe("bills overview", () => {
  useTestDB();

  it("groups bills and reports counts; the exact reference match waits for the user", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const overdue = await seedBill(u.id, { dueDate: daysFromToday(-3) });
    const soon = await seedBill(u.id, { dueDate: daysFromToday(5) });
    const paid = await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      dueDate: daysFromToday(2),
      issueDate: daysFromToday(-20),
    });
    await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
      bookingDate: daysFromToday(-1),
      reference: EXAMPLE_QRR,
    });

    const r = await loadAs(u);
    expect(r.type).toBe("return");
    const v = (r as { value: Awaited<ReturnType<typeof load>> & object })
      .value as never as {
      groups: Record<string, { id: string }[]>;
      suggestions: unknown[];
      counts: Record<string, number>;
      autoMatchPending: number;
      query: unknown;
      list: { items: { id: string }[]; total: number };
    };
    expect(Object.keys(v.groups).sort()).toEqual([
      "awaitingRefund",
      "dueSoon",
      "overdue",
    ]);
    expect(v.autoMatchPending).toBe(1);
    expect(await listBillAllocations(u.id, paid.id)).toEqual([]);
    expect(v.groups.overdue!.map((b) => b.id)).toEqual([overdue.id]);
    expect(v.groups.dueSoon!.map((b) => b.id).sort()).toEqual(
      [soon.id, paid.id].sort(),
    );
    expect(v.counts).toMatchObject({
      overdue: 1,
      dueSoon: 2,
      recentlyPaid: 0,
      paid: 0,
      total: 3,
    });
    expect(v.suggestions).toHaveLength(1);
    expect(v.query).toEqual({ q: "", status: "all", page: 1 });
    expect(v.list.total).toBe(3);
    expect(v.list.items.map((b) => b.id).sort()).toEqual(
      [overdue.id, soon.id, paid.id].sort(),
    );

    // Loading again changes nothing either.
    const again = (await loadAs(u)) as { value: { autoMatchPending: number } };
    expect(again.value.autoMatchPending).toBe(1);
    expect(await listBillAllocations(u.id, paid.id)).toEqual([]);

    const matched = await run("matchNow", u, {});
    expect(matched).toEqual({
      type: "return",
      value: { success: true, action: "matchNow", matched: 1 },
    });
    expect(await listBillAllocations(u.id, paid.id)).toHaveLength(1);
    const after = (await loadAs(u)) as {
      value: { autoMatchPending: number; suggestions: unknown[] };
    };
    expect(after.value.autoMatchPending).toBe(0);
    expect(after.value.suggestions).toEqual([]);
  });

  it("load writes nothing", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    await seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      dueDate: daysFromToday(2),
      issueDate: daysFromToday(-20),
    });
    await seedImportedTransaction(u.id, account.id, {
      amount: minor(-10000),
      bookingDate: daysFromToday(-1),
      reference: EXAMPLE_QRR,
    });
    const db = getDB();
    const emitted = vi.fn();
    const off = onBillChanged(emitted);
    const counts = async () => ({
      allocations: (await db.select().from(billAllocations)).length,
      dismissals: (await db.select().from(matchDismissals)).length,
      bills: await db.select().from(bills),
    });
    const before = await counts();
    await loadAs(u);
    await loadAs(u, "?status=overdue");
    expect(await counts()).toEqual(before);
    expect(emitted).not.toHaveBeenCalled();
    off();
  });

  it("matchNow only touches the current user's bills", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const account = await seedAccount(other.id);
    const bill = await seedBill(other.id, {
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    await seedImportedTransaction(other.id, account.id, {
      amount: minor(-10000),
      bookingDate: daysFromToday(-1),
      reference: EXAMPLE_QRR,
    });
    expect(await run("matchNow", u, {})).toMatchObject({
      value: { matched: 0 },
    });
    expect(await listBillAllocations(other.id, bill.id)).toEqual([]);
  });

  it("filters and paginates the list from the query string", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acme = await seedBill(u.id, {
      creditorName: "Acme Utilities",
      dueDate: daysFromToday(-3),
    });
    await seedBill(u.id, {
      creditorName: "Other Co",
      dueDate: daysFromToday(30),
    });
    await seedBill(other.id, { creditorName: "Acme Utilities" });

    const val = async (search: string) =>
      ((await loadAs(u, search)) as unknown as { value: never }).value as {
        query: unknown;
        list: { items: { id: string }[]; total: number; page: number };
      };

    const byText = await val("?q=acme");
    expect(byText.query).toEqual({ q: "acme", status: "all", page: 1 });
    expect(byText.list.items.map((b) => b.id)).toEqual([acme.id]);

    const byStatus = await val("?status=overdue");
    expect(byStatus.list.items.map((b) => b.id)).toEqual([acme.id]);
    expect((await val("?status=paid")).list.total).toBe(0);

    const paged = await val("?page=9&status=bogus");
    expect(paged.query).toEqual({ q: "", status: "all", page: 9 });
    expect(paged.list).toMatchObject({ total: 2, page: 1 });
  });

  it("only shows the user's own bills", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedBill(a.id);
    const r = (await loadAs(b)) as { value: { counts: { total: number } } };
    expect(r.value.counts.total).toBe(0);
  });

  it("confirms a suggestion with a typed amount and dismisses others", async () => {
    const u = await createTestUser();
    const account = await seedAccount(u.id);
    const bill = await seedBill(u.id);
    const tx = await seedImportedTransaction(u.id, account.id, {
      amount: minor(-2550),
    });

    const bad = await run("confirmSuggestion", u, {
      billId: bill.id,
      transactionId: tx.id,
      amount: "99.00",
    });
    expect(bad).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "confirmSuggestion",
        errors: { amount: [expect.any(String)] },
      },
    });
    const missing = await run("confirmSuggestion", u, { billId: bill.id });
    expect(missing).toMatchObject({ type: "fail", status: 400 });

    const ok = await run("confirmSuggestion", u, {
      billId: bill.id,
      transactionId: tx.id,
      amount: "25.50",
    });
    expect(ok).toEqual({
      type: "return",
      value: { success: true, action: "confirmSuggestion" },
    });
    expect((await listBillAllocations(u.id, bill.id))[0]).toMatchObject({
      amount: 2550,
      origin: "user",
    });

    const dismissed = await run("dismissSuggestion", u, {
      billId: bill.id,
      transactionId: tx.id,
    });
    expect(dismissed).toEqual({
      type: "return",
      value: { success: true, action: "dismissSuggestion" },
    });
  });

  it("cannot confirm or dismiss another user's suggestion", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accountA = await seedAccount(a.id);
    const billA = await seedBill(a.id);
    const txA = await seedImportedTransaction(a.id, accountA.id, {
      amount: minor(-1000),
    });
    const accountB = await seedAccount(b.id);
    const billB = await seedBill(b.id);
    const txB = await seedImportedTransaction(b.id, accountB.id, {
      amount: minor(-1000),
    });

    for (const [bill, tx] of [
      [billA, txA],
      [billB, txA],
      [billA, txB],
    ] as const) {
      const form = { billId: bill.id, transactionId: tx.id, amount: "10.00" };
      expect(await run("confirmSuggestion", b, form)).toEqual({
        type: "error",
        status: 404,
      });
    }
    expect(
      await run("dismissSuggestion", b, {
        billId: billA.id,
        transactionId: txB.id,
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await run("dismissSuggestion", b, {
        billId: billB.id,
        transactionId: txA.id,
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(await listBillAllocations(a.id, billA.id)).toEqual([]);
  });
});
