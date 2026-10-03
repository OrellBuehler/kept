import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
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

  it("groups bills, reports counts and auto-matches exact references", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const overdue = seedBill(u.id, { dueDate: daysFromToday(-3) });
    const soon = seedBill(u.id, { dueDate: daysFromToday(5) });
    const paid = seedBill(u.id, {
      creditorIban: EXAMPLE_IBAN_OTHER,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      dueDate: daysFromToday(2),
      issueDate: daysFromToday(-20),
    });
    seedImportedTransaction(u.id, account.id, {
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
      autoMatched: number;
      query: unknown;
      list: { items: { id: string }[]; total: number };
    };
    expect(Object.keys(v.groups).sort()).toEqual([
      "awaitingRefund",
      "dueSoon",
      "overdue",
    ]);
    expect(v.autoMatched).toBe(1);
    expect(v.groups.overdue!.map((b) => b.id)).toEqual([overdue.id]);
    expect(v.groups.dueSoon!.map((b) => b.id)).toEqual([soon.id]);
    expect(v.counts).toMatchObject({
      overdue: 1,
      dueSoon: 1,
      recentlyPaid: 1,
      paid: 1,
      total: 3,
    });
    expect(v.suggestions).toEqual([]);
    expect(v.query).toEqual({ q: "", status: "all", page: 1 });
    expect(v.list.total).toBe(3);
    expect(v.list.items.map((b) => b.id).sort()).toEqual(
      [overdue.id, soon.id, paid.id].sort(),
    );

    const again = (await loadAs(u)) as { value: { autoMatched: number } };
    expect(again.value.autoMatched).toBe(0);
  });

  it("filters and paginates the list from the query string", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acme = seedBill(u.id, {
      creditorName: "Acme Utilities",
      dueDate: daysFromToday(-3),
    });
    seedBill(u.id, { creditorName: "Other Co", dueDate: daysFromToday(30) });
    seedBill(other.id, { creditorName: "Acme Utilities" });

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
    seedBill(a.id);
    const r = (await loadAs(b)) as { value: { counts: { total: number } } };
    expect(r.value.counts.total).toBe(0);
  });

  it("confirms a suggestion with a typed amount and dismisses others", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const bill = seedBill(u.id);
    const tx = seedImportedTransaction(u.id, account.id, {
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
    expect(listBillAllocations(u.id, bill.id)[0]).toMatchObject({
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
    const accountA = seedAccount(a.id);
    const billA = seedBill(a.id);
    const txA = seedImportedTransaction(a.id, accountA.id, {
      amount: minor(-1000),
    });
    const accountB = seedAccount(b.id);
    const billB = seedBill(b.id);
    const txB = seedImportedTransaction(b.id, accountB.id, {
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
    expect(listBillAllocations(a.id, billA.id)).toEqual([]);
  });
});
