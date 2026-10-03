import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { billsToItems, unprojectedBills, type ForecastBill } from "./bills";
import {
  projectForecast,
  type ForecastAccount,
  type ProjectedItem,
} from "./projection";

const FROM = "2026-10-01";

const account = (over: Partial<ForecastAccount> = {}): ForecastAccount => ({
  id: "a1",
  name: "Main",
  currency: "CHF",
  balance: minor(100_000),
  threshold: null,
  defaultPayment: false,
  ...over,
});

const item = (over: Partial<ProjectedItem> = {}): ProjectedItem => ({
  date: "2026-10-05",
  amount: minor(-10_000),
  currency: "CHF",
  accountId: "a1",
  source: "bill",
  label: "Example Supplier",
  ...over,
});

const bill = (over: Partial<ForecastBill> = {}): ForecastBill => ({
  id: "b1",
  kind: "invoice",
  status: "open",
  amount: minor(10_000),
  remaining: minor(10_000),
  currency: "CHF",
  dueDate: "2026-10-10",
  creditorName: "Example Supplier",
  invoiceNumber: null,
  expectedAccountId: "a1",
  ...over,
});

describe("projectForecast", () => {
  it("projects day by day from the current balance", () => {
    const f = projectForecast({
      accounts: [account()],
      items: [item({ date: "2026-10-03" }), item({ date: "2026-10-03" })],
      from: FROM,
      days: 5,
    });
    const p = f.accounts[0]!;
    expect(p.points).toHaveLength(6);
    expect(p.points.map((x) => x.balance)).toEqual([
      100_000, 100_000, 80_000, 80_000, 80_000, 80_000,
    ]);
    expect(p.startBalance).toBe(100_000);
    expect(p.endBalance).toBe(80_000);
    expect(p.lowest).toEqual({ date: "2026-10-03", balance: 80_000 });
    expect(p.warning).toBeNull();
    expect(f.to).toBe("2026-10-06");
  });

  it("ignores items after the horizon and moves earlier items to the first day", () => {
    const f = projectForecast({
      accounts: [account()],
      items: [
        item({ date: "2026-09-20", amount: minor(-5_000) }),
        item({ date: "2026-10-20" }),
      ],
      from: FROM,
      days: 5,
    });
    expect(f.items).toHaveLength(1);
    expect(f.items[0]!.date).toBe(FROM);
    expect(f.accounts[0]!.points[0]!.balance).toBe(95_000);
  });

  it("adds income", () => {
    const f = projectForecast({
      accounts: [account()],
      items: [item({ amount: minor(50_000), source: "planned" })],
      from: FROM,
      days: 10,
    });
    expect(f.accounts[0]!.endBalance).toBe(150_000);
  });

  it("warns on the first day the balance is below zero", () => {
    const f = projectForecast({
      accounts: [account({ balance: minor(5_000) })],
      items: [
        item({ date: "2026-10-04", amount: minor(-4_000) }),
        item({ date: "2026-10-06", amount: minor(-4_000) }),
        item({ date: "2026-10-08", amount: minor(-4_000) }),
      ],
      from: FROM,
      days: 10,
    });
    const p = f.accounts[0]!;
    expect(p.warning).toEqual({
      date: "2026-10-06",
      balance: -3_000,
      limit: 0,
      negative: true,
    });
    expect(p.negativeDate).toBe("2026-10-06");
    expect(p.lowest.balance).toBe(-7_000);
  });

  it("warns when crossing a threshold above zero and flags it as not negative", () => {
    const f = projectForecast({
      accounts: [account({ balance: minor(50_000), threshold: minor(20_000) })],
      items: [
        item({ date: "2026-10-02", amount: minor(-20_000) }),
        item({ date: "2026-10-09", amount: minor(-20_000) }),
      ],
      from: FROM,
      days: 10,
    });
    const p = f.accounts[0]!;
    expect(p.warning).toEqual({
      date: "2026-10-09",
      balance: 10_000,
      limit: 20_000,
      negative: false,
    });
    expect(p.negativeDate).toBeNull();
  });

  it("does not warn when the balance only touches the threshold", () => {
    const f = projectForecast({
      accounts: [account({ balance: minor(30_000), threshold: minor(20_000) })],
      items: [item({ amount: minor(-10_000) })],
      from: FROM,
      days: 10,
    });
    expect(f.accounts[0]!.warning).toBeNull();
  });

  it("warns from the first day when the account is already below its limit", () => {
    const f = projectForecast({
      accounts: [account({ balance: minor(-100) })],
      items: [],
      from: FROM,
      days: 3,
    });
    expect(f.accounts[0]!.warning?.date).toBe(FROM);
  });

  it("starts an account without balance at zero and does not warn", () => {
    const f = projectForecast({
      accounts: [account({ balance: null })],
      items: [item()],
      from: FROM,
      days: 10,
    });
    const p = f.accounts[0]!;
    expect(p.hasBalance).toBe(false);
    expect(p.startBalance).toBe(0);
    expect(p.endBalance).toBe(-10_000);
    expect(p.warning).toBeNull();
    expect(p.negativeDate).toBeNull();
  });

  it("keeps currencies apart", () => {
    const f = projectForecast({
      accounts: [
        account(),
        account({
          id: "a2",
          name: "Euro",
          currency: "EUR",
          balance: minor(500),
        }),
      ],
      items: [
        item(),
        item({ accountId: "a2", currency: "EUR", amount: minor(-1_000) }),
      ],
      from: FROM,
      days: 10,
    });
    expect(f.accounts[0]!.endBalance).toBe(90_000);
    expect(f.accounts[1]!.endBalance).toBe(-500);
    expect(f.accounts[1]!.warning?.negative).toBe(true);
    expect(f.accounts[0]!.warning).toBeNull();
  });

  it("assigns items without account to the default payment account of their currency", () => {
    const f = projectForecast({
      accounts: [
        account(),
        account({
          id: "a2",
          name: "Bills",
          balance: minor(20_000),
          defaultPayment: true,
        }),
        account({
          id: "a3",
          name: "Euro",
          currency: "EUR",
          defaultPayment: true,
        }),
      ],
      items: [item({ accountId: null })],
      from: FROM,
      days: 10,
    });
    expect(f.accounts.map((a) => a.endBalance)).toEqual([
      100_000, 10_000, 100_000,
    ]);
    expect(f.unassigned).toEqual([]);
  });

  it("treats an account of a different currency or an unknown account as unassigned", () => {
    const f = projectForecast({
      accounts: [account()],
      items: [
        item({ currency: "EUR", accountId: "a1", amount: minor(-300) }),
        item({ accountId: "gone", amount: minor(-200) }),
        item({ accountId: null, amount: minor(700), source: "planned" }),
        item({ accountId: null, currency: "EUR", amount: minor(-100) }),
      ],
      from: FROM,
      days: 10,
    });
    expect(f.accounts[0]!.endBalance).toBe(100_000);
    expect(f.unassigned).toEqual([
      { currency: "CHF", inflow: 700, outflow: -200, count: 2 },
      { currency: "EUR", inflow: 0, outflow: -400, count: 2 },
    ]);
  });

  it("sorts the item list by date", () => {
    const f = projectForecast({
      accounts: [account()],
      items: [item({ date: "2026-10-09" }), item({ date: "2026-10-02" })],
      from: FROM,
      days: 10,
    });
    expect(f.items.map((i) => i.date)).toEqual(["2026-10-02", "2026-10-09"]);
  });
});

describe("billsToItems", () => {
  it("projects the open amount on the due date from the paying account", () => {
    expect(billsToItems([bill()], FROM)).toEqual([
      {
        date: "2026-10-10",
        amount: -10_000,
        currency: "CHF",
        accountId: "a1",
        source: "bill",
        label: "Example Supplier",
        ref: "b1",
      },
    ]);
  });

  it("uses only what is still open for partially paid bills", () => {
    const items = billsToItems(
      [bill({ status: "partially_paid", remaining: minor(3_500) })],
      FROM,
    );
    expect(items[0]!.amount).toBe(-3_500);
  });

  it("moves overdue bills to the first forecast day", () => {
    const items = billsToItems([bill({ dueDate: "2026-09-01" })], FROM);
    expect(items[0]!.date).toBe(FROM);
  });

  it("skips paid, cancelled, overpaid, credit notes and bills without due date or amount", () => {
    const items = billsToItems(
      [
        bill({ id: "paid", status: "paid", remaining: minor(0) }),
        bill({ id: "cancelled", status: "cancelled" }),
        bill({ id: "over", status: "overpaid", remaining: minor(0) }),
        bill({ id: "credit", kind: "credit_note", status: "credit_due" }),
        bill({ id: "undated", dueDate: null }),
        bill({ id: "openamount", amount: null, remaining: null }),
      ],
      FROM,
    );
    expect(items).toEqual([]);
  });

  it("falls back to the invoice number and then a generic label", () => {
    const items = billsToItems(
      [
        bill({ id: "x", creditorName: null, invoiceNumber: "INV-1" }),
        bill({ id: "y", creditorName: null }),
      ],
      FROM,
    );
    expect(items.map((i) => i.label)).toEqual(["INV-1", "Bill"]);
  });

  it("counts unpaid invoices that cannot be projected", () => {
    expect(
      unprojectedBills([
        bill({ id: "undated", dueDate: null }),
        bill({ id: "openamount", amount: null, remaining: null }),
        bill({ id: "paid", status: "paid", dueDate: null }),
        bill(),
      ]),
    ).toEqual({ noDueDate: 1, noAmount: 1 });
  });
});
