import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { updatePreferences } from "$lib/server/preferences";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  computeLiquidity,
  liquidity,
  withdrawnThisPeriod,
  type LiquidityAccount,
} from "./liquidity";
import { dashboard } from "./index";

const TODAY = "2026-10-15";
const m = minor;

let seq = 0;
function acct(over: Partial<LiquidityAccount> = {}): LiquidityAccount {
  seq += 1;
  return {
    id: `a${seq}`,
    name: `Account ${seq}`,
    type: "current",
    currency: "CHF",
    shareBps: 10000,
    balance: m(0),
    cashBalance: m(0),
    noticeMonths: null,
    freeWithdrawal: null,
    freeWithdrawalPeriod: null,
    ...over,
  };
}

const compute = (
  accounts: LiquidityAccount[],
  over: {
    investmentCashLiquid?: boolean;
    used?: Record<string, number>;
  } = {},
) =>
  computeLiquidity(accounts, {
    today: TODAY,
    investmentCashLiquid: over.investmentCashLiquid ?? false,
    usedThisPeriod: new Map(Object.entries(over.used ?? {})),
  });

describe("computeLiquidity", () => {
  it("is empty without accounts", () => {
    expect(compute([])).toEqual([]);
  });

  it("skips a currency whose accounts all net to nothing", () => {
    expect(
      compute([
        acct({ currency: "EUR", type: "pillar_3a", balance: m(0) }),
        acct({ currency: "EUR", balance: m(0), cashBalance: m(0) }),
      ]),
    ).toEqual([]);
  });

  it("keeps a currency that only has excluded totals", () => {
    const r = compute([
      acct({ currency: "EUR", type: "pillar_3a", balance: m(700) }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.now).toEqual({ balance: 0, shareBalance: 0 });
    expect(r[0]!.excluded.map((e) => e.reason)).toEqual(["pension"]);
  });

  it("counts plain accounts as available now", () => {
    const r = compute([
      acct({ balance: m(1000), cashBalance: m(1000) }),
      acct({ type: "savings", balance: m(500), cashBalance: m(500) }),
      acct({ type: "cash", balance: m(20), cashBalance: m(20) }),
      acct({ type: "other", balance: m(30), cashBalance: m(30) }),
    ]);
    expect(r).toEqual([
      {
        currency: "CHF",
        now: { balance: 1550, shareBalance: 1550 },
        ladder: [],
        excluded: [],
      },
    ]);
  });

  it("puts a notice account without a free amount fully on the ladder", () => {
    const savings = acct({
      type: "savings",
      name: "Notice",
      balance: m(10000),
      cashBalance: m(10000),
      noticeMonths: 6,
    });
    const [r] = compute([savings]);
    expect(r!.now).toEqual({ balance: 0, shareBalance: 0 });
    expect(r!.ladder).toEqual([
      {
        months: 6,
        availableFrom: "2027-04-15",
        balance: 10000,
        shareBalance: 10000,
        accounts: [{ id: savings.id, name: "Notice" }],
      },
    ]);
  });

  it("makes the unused free amount available now (monthly and yearly)", () => {
    const monthly = acct({
      type: "savings",
      balance: m(10000),
      cashBalance: m(10000),
      noticeMonths: 3,
      freeWithdrawal: m(2000),
      freeWithdrawalPeriod: "month",
    });
    const yearly = acct({
      type: "savings",
      balance: m(50000),
      cashBalance: m(50000),
      noticeMonths: 6,
      freeWithdrawal: m(25000),
      freeWithdrawalPeriod: "year",
    });
    const [r] = compute([monthly, yearly], {
      used: { [monthly.id]: 500, [yearly.id]: 0 },
    });
    expect(r!.now.balance).toBe(1500 + 25000);
    expect(r!.ladder.map((s) => [s.months, s.balance])).toEqual([
      [3, 8500],
      [6, 25000],
    ]);
  });

  it("handles partly and fully used free amounts and small balances", () => {
    const full = acct({
      balance: m(10000),
      cashBalance: m(10000),
      noticeMonths: 6,
      freeWithdrawal: m(1000),
      freeWithdrawalPeriod: "year",
    });
    expect(compute([full], { used: { [full.id]: 1000 } })[0]!.now.balance).toBe(
      0,
    );
    expect(compute([full], { used: { [full.id]: 5000 } })[0]!.now.balance).toBe(
      0,
    );
    const small = acct({
      balance: m(300),
      cashBalance: m(300),
      noticeMonths: 6,
      freeWithdrawal: m(1000),
      freeWithdrawalPeriod: "year",
    });
    const [r] = compute([small]);
    expect(r!.now.balance).toBe(300);
    expect(r!.ladder).toEqual([]);
  });

  it("counts an overdrawn notice account as debt, not as free money", () => {
    const overdrawn = acct({
      balance: m(-400),
      cashBalance: m(-400),
      noticeMonths: 6,
      freeWithdrawal: m(1000),
      freeWithdrawalPeriod: "year",
    });
    const [r] = compute([overdrawn]);
    expect(r!.now.balance).toBe(-400);
    expect(r!.ladder).toEqual([]);
  });

  it("subtracts credit card debt", () => {
    const [r] = compute([
      acct({ balance: m(1000), cashBalance: m(1000) }),
      acct({ type: "credit_card", balance: m(-300), cashBalance: m(-300) }),
    ]);
    expect(r!.now.balance).toBe(700);
  });

  it("counts investment cash only when enabled and never the securities", () => {
    const inv = acct({
      type: "investment",
      balance: m(120000),
      cashBalance: m(2000),
    });
    const off = compute([inv])[0]!;
    expect(off.now.balance).toBe(0);
    expect(off.excluded).toEqual([
      {
        reason: "investment_cash",
        balance: 2000,
        shareBalance: 2000,
        accountCount: 1,
      },
    ]);
    const on = compute([inv], { investmentCashLiquid: true })[0]!;
    expect(on.now.balance).toBe(2000);
    expect(on.excluded).toEqual([]);
  });

  it("excludes pension and pillar 3a", () => {
    const [r] = compute([
      acct({ type: "pension", balance: m(80000), cashBalance: m(0) }),
      acct({ type: "pillar_3a", balance: m(20000), cashBalance: m(0) }),
      acct({ type: "pension", balance: m(0), cashBalance: m(0) }),
    ]);
    expect(r!.now.balance).toBe(0);
    expect(r!.excluded).toEqual([
      {
        reason: "pension",
        balance: 100000,
        shareBalance: 100000,
        accountCount: 3,
      },
    ]);
  });

  it("separates currencies and applies the ownership share", () => {
    const shared = acct({
      balance: m(1001),
      cashBalance: m(1001),
      shareBps: 5000,
    });
    const euro = acct({
      currency: "EUR",
      balance: m(200),
      cashBalance: m(200),
    });
    const sharedNotice = acct({
      type: "savings",
      balance: m(10000),
      cashBalance: m(10000),
      shareBps: 2500,
      noticeMonths: 6,
      freeWithdrawal: m(4000),
      freeWithdrawalPeriod: "year",
    });
    const r = compute([shared, euro, sharedNotice]);
    expect(r.map((c) => c.currency)).toEqual(["CHF", "EUR"]);
    const chf = r[0]!;
    expect(chf.now).toEqual({
      balance: 1001 + 4000,
      shareBalance: 501 + 1000,
    });
    expect(chf.ladder[0]).toMatchObject({ balance: 6000, shareBalance: 1500 });
    expect(r[1]!.now).toEqual({ balance: 200, shareBalance: 200 });
  });

  it("groups accounts with the same notice period into one step", () => {
    const a = acct({
      balance: m(100),
      cashBalance: m(100),
      noticeMonths: 12,
    });
    const b = acct({
      balance: m(50),
      cashBalance: m(50),
      noticeMonths: 12,
    });
    const c = acct({
      balance: m(10),
      cashBalance: m(10),
      noticeMonths: 1,
    });
    const [r] = compute([a, b, c]);
    expect(
      r!.ladder.map((s) => [s.months, s.availableFrom, s.balance]),
    ).toEqual([
      [1, "2026-11-15", 10],
      [12, "2027-10-15", 150],
    ]);
    expect(r!.ladder[1]!.accounts.map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it("clamps the available date to the end of a short month", () => {
    const a = acct({
      balance: m(100),
      cashBalance: m(100),
      noticeMonths: 1,
    });
    const r = computeLiquidity([a], {
      today: "2026-01-31",
      investmentCashLiquid: false,
      usedThisPeriod: new Map(),
    });
    expect(r[0]!.ladder[0]!.availableFrom).toBe("2026-02-28");
  });
});

describe("liquidity (database)", () => {
  useTestDB();

  it("sums debits of the current month or year for notice accounts only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const yearly = await seedAccount(u.id, {
      type: "savings",
      noticeMonths: 6,
      freeWithdrawal: m(25000),
      freeWithdrawalPeriod: "year",
    });
    const monthly = await seedAccount(u.id, {
      name: "Monthly",
      type: "savings",
      noticeMonths: 3,
      freeWithdrawal: m(1000),
      freeWithdrawalPeriod: "month",
    });
    const plain = await seedAccount(u.id, { name: "Plain" });
    const foreign = await seedAccount(other.id, {
      type: "savings",
      noticeMonths: 6,
      freeWithdrawal: m(100),
      freeWithdrawalPeriod: "year",
    });
    for (const [account, bookingDate, amount, owner] of [
      [yearly.id, "2026-02-10", -3000, u.id],
      [yearly.id, "2026-10-01", -500, u.id],
      [yearly.id, "2026-10-02", 9000, u.id],
      [yearly.id, "2025-12-31", -7777, u.id],
      [yearly.id, "2026-11-01", -8888, u.id],
      [monthly.id, "2026-09-30", -400, u.id],
      [monthly.id, "2026-10-03", -250, u.id],
      [monthly.id, "2026-10-15", -50, u.id],
      [plain.id, "2026-10-03", -999, u.id],
      [foreign.id, "2026-10-03", -42, other.id],
    ] as const) {
      await seedImportedTransaction(owner, account, {
        bookingDate,
        amount: m(amount),
      });
    }
    const used = withdrawnThisPeriod(
      u.id,
      [
        { id: yearly.id, ...pick(yearly) },
        { id: monthly.id, ...pick(monthly) },
        { id: plain.id, ...pick(plain) },
        { id: foreign.id, ...pick(foreign) },
      ],
      TODAY,
    );
    expect(used.get(yearly.id)).toBe(3500);
    expect(used.get(monthly.id)).toBe(300);
    expect(used.has(plain.id)).toBe(false);
    expect(used.has(foreign.id)).toBe(false);
  });

  it("builds the dashboard figures with the used allowance and the preference", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    await seedAccount(u.id, { name: "Current", openingBalance: m(2000) });
    await seedAccount(u.id, {
      name: "Card",
      type: "credit_card",
      openingBalance: m(-300),
    });
    const savings = await seedAccount(u.id, {
      name: "Savings",
      type: "savings",
      openingBalance: m(60000),
      noticeMonths: 6,
      freeWithdrawal: m(25000),
      freeWithdrawalPeriod: "year",
    });
    await seedImportedTransaction(u.id, savings.id, {
      bookingDate: "2026-03-01",
      amount: m(-5000),
    });
    const inv = await seedAccount(u.id, {
      name: "Broker",
      type: "investment",
      openingBalance: m(400),
    });
    const sec = seedSecurity(u.id);
    seedTrade(u.id, inv.id, sec.id, {
      date: "2026-01-10",
      qty: "10",
      price: "100",
      amount: 100000,
    });
    seedProviderPrice(u.id, sec.id, "2026-10-14", "120");
    await seedAccount(u.id, {
      name: "Old age",
      type: "pension",
      openingBalance: m(900),
    });
    await seedAccount(other.id, { openingBalance: m(999999) });

    const [off] = await liquidity(u.id, TODAY);
    expect(off!.now).toEqual({
      balance: 2000 - 300 + (25000 - 5000),
      shareBalance: 2000 - 300 + (25000 - 5000),
    });
    expect(off!.ladder).toHaveLength(1);
    expect(off!.ladder[0]).toMatchObject({
      months: 6,
      availableFrom: "2027-04-15",
      balance: 60000 - 5000 - 20000,
    });
    expect(off!.excluded.map((e) => [e.reason, e.balance])).toEqual([
      ["investment_cash", 400],
      ["pension", 900],
    ]);

    updatePreferences(u.id, { investmentCashLiquid: true });
    const d = await dashboard(u.id, TODAY);
    expect(d.liquidity[0]!.now.balance).toBe(2000 - 300 + 20000 + 400);
    expect(d.liquidity[0]!.excluded.map((e) => e.reason)).toEqual(["pension"]);
    expect(d.invested).toEqual([
      expect.objectContaining({
        currency: "CHF",
        value: 120000,
        cost: 100000,
        gain: 20000,
        accountCount: 1,
        estimated: false,
      }),
    ]);

    const foreign = await dashboard(other.id, TODAY);
    expect(foreign.liquidity).toEqual([
      expect.objectContaining({
        now: { balance: 999999, shareBalance: 999999 },
      }),
    ]);
    expect(foreign.invested).toEqual([]);
  });

  it("does not count archived accounts", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id, { openingBalance: m(1000) });
    const { archiveAccount } = await import("$lib/server/ledger");
    await archiveAccount(u.id, a.id);
    expect((await dashboard(u.id, TODAY)).liquidity).toEqual([]);
  });
});

function pick(a: {
  noticeMonths: number | null;
  freeWithdrawalPeriod: "month" | "year" | null;
}) {
  return {
    noticeMonths: a.noticeMonths,
    freeWithdrawalPeriod: a.freeWithdrawalPeriod,
  };
}
