import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { accountBalances } from "$lib/server/dashboard/accounts";
import { liquidity } from "$lib/server/dashboard/liquidity";
import { netWorthSeries } from "$lib/server/dashboard/net-worth";
import { forecast } from "$lib/server/forecast";
import { anchoredBalanceAt } from "$lib/server/imports/preview";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { linkTransfers } from "$lib/server/transfers";
import { getAccount, updateAccount } from "./accounts";
import {
  accountBalanceAt,
  accountValue,
  balanceAt,
  balanceSeries,
  cashBalanceAt,
  cashMovesOf,
  currentBalance,
  currentValues,
  makeBalanceAt,
  type BalanceInput,
} from "./balances";
import { createSnapshot } from "./snapshots";

const base: BalanceInput = {
  openingBalance: 0,
  openingDate: null,
  snapshots: [],
  transactions: [],
};
const moves = [
  { date: "2024-01-10", amount: -60000 },
  { date: "2024-02-10", amount: 20000 },
];

describe("cash moves (pure)", () => {
  it("count in the continuity check that works backwards from a later snapshot", () => {
    const input: BalanceInput = {
      ...base,
      snapshots: [{ date: "2024-03-01", amount: 60000 }],
      cashMoves: moves,
    };
    // 60000 at 03-01 minus the sell (02-10) and buy (01-10) after 01-05
    expect(anchoredBalanceAt(input, "2024-01-05")).toBe(100000);
  });

  it("count like transactions", () => {
    const input: BalanceInput = {
      ...base,
      transactions: [{ bookingDate: "2024-01-02", amount: 100000 }],
      cashMoves: moves,
    };
    expect(balanceAt(input, "2024-01-09")).toBe(100000);
    expect(balanceAt(input, "2024-01-10")).toBe(40000);
    expect(balanceAt(input, "2024-02-09")).toBe(40000);
    expect(balanceAt(input, "2024-02-10")).toBe(60000);
    expect(cashBalanceAt(input, "2024-02-10")).toBe(60000);
    expect(balanceAt({ ...input, cashMoves: undefined }, "2024-02-10")).toBe(
      100000,
    );
  });

  it("follow the snapshot rule: only moves after the latest snapshot count", () => {
    const input: BalanceInput = {
      ...base,
      snapshots: [{ date: "2024-02-10", amount: 50000 }],
      cashMoves: moves,
    };
    // the snapshot is an end-of-day balance: the sell on its date is already in it
    expect(balanceAt(input, "2024-02-10")).toBe(50000);
    expect(balanceAt(input, "2024-02-09")).toBe(-60000);
    expect(
      balanceAt(
        {
          ...input,
          cashMoves: [...moves, { date: "2024-03-01", amount: -500 }],
        },
        "2024-03-01",
      ),
    ).toBe(49500);
  });

  it("ignore moves before the opening date", () => {
    const input: BalanceInput = {
      ...base,
      openingBalance: 1000,
      openingDate: "2024-01-20",
      cashMoves: moves,
    };
    expect(balanceAt(input, "2024-01-31")).toBe(1000);
    expect(balanceAt(input, "2024-02-10")).toBe(21000);
  });

  it("are derived from buys and sells, never from splits", () => {
    expect(
      cashMovesOf({
        accountCurrency: "CHF",
        securities: [],
        prices: [],
        fx: [],
        trades: [
          {
            securityId: "s",
            date: "2024-01-01",
            side: "buy",
            quantity: 1 as never,
            price: 1 as never,
            amount: 500,
          },
          {
            securityId: "s",
            date: "2024-01-02",
            side: "split",
            quantity: 1 as never,
            price: 1 as never,
            amount: 0,
          },
          {
            securityId: "s",
            date: "2024-01-03",
            side: "sell",
            quantity: 1 as never,
            price: 1 as never,
            amount: 200,
          },
        ],
      }),
    ).toEqual([
      { date: "2024-01-01", amount: -500 },
      { date: "2024-01-03", amount: 200 },
    ]);
    expect(cashMovesOf(undefined)).toEqual([]);
    expect(makeBalanceAt(base)("2024-01-01")).toBe(0);
  });
});

async function setup(tradesMoveCash = true) {
  const user = await createTestUser();
  const main = await seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
  const broker = await seedAccount(user.id, {
    name: "Broker",
    type: "investment",
    iban: EXAMPLE_IBAN_OTHER,
    fillFromTransfers: true,
    tradesMoveCash,
  });
  // 1000.00 moves from Main to Broker, mirrored onto Broker.
  const deposit = await seedImportedTransaction(user.id, main.id, {
    bookingDate: "2024-01-02",
    amount: minor(-100000),
    counterpartyIban: EXAMPLE_IBAN_OTHER,
  });
  await linkTransfers(user.id, { transactionIds: [deposit.id] });
  const sec = await seedSecurity(user.id);
  // buy 600.00 on 01-10, sell 200.00 on 02-10; 4 units remain, priced at 130.00.
  await seedTrade(user.id, broker.id, sec.id, {
    date: "2024-01-10",
    qty: "6",
    price: "100",
    amount: 60000,
  });
  await seedTrade(user.id, broker.id, sec.id, {
    date: "2024-02-10",
    side: "sell",
    qty: "2",
    price: "100",
    amount: 20000,
  });
  await seedProviderPrice(user.id, sec.id, "2024-03-01", "130");
  return { user, main, broker };
}

describe("trades move cash", () => {
  useTestDB();

  it("a buy lowers and a sell raises cash, and holdings come on top", async () => {
    const { user, broker } = await setup();
    const value = await accountValue(user.id, broker.id, "2024-12-31");
    expect(value).toMatchObject({
      cash: 60000,
      holdings: 52000,
      total: 112000,
    });
    // deposit 1000.00, gain: 4 units at 130.00 = 520.00 vs 400.00 paid
    expect(value.total).toBe(100000 + (52000 - 40000));
    expect(await currentBalance(user.id, broker.id, "2024-12-31")).toBe(112000);
    expect(await accountBalanceAt(user.id, broker.id, "2024-01-31")).toBe(
      40000,
    );
    expect(await accountBalanceAt(user.id, broker.id, "2024-12-31")).toBe(
      60000,
    );
    expect(await getAccount(user.id, broker.id, "2024-12-31")).toMatchObject({
      tradesMoveCash: true,
      cashBalance: 60000,
      balance: 112000,
    });
  });

  it("is off by default: trades leave the cash balance alone", async () => {
    const { user, broker } = await setup(false);
    expect(await accountValue(user.id, broker.id, "2024-12-31")).toMatchObject({
      cash: 100000,
      holdings: 52000,
      total: 152000,
    });
  });

  it("only counts trades after the latest snapshot", async () => {
    const { user, broker } = await setup();
    await createSnapshot(user.id, broker.id, {
      date: "2024-01-31",
      amount: minor(45000),
      note: null,
    });
    // buy (01-10) is inside the snapshot, the sell (02-10) comes after it
    expect((await accountValue(user.id, broker.id, "2024-12-31")).cash).toBe(
      65000,
    );
    expect(await accountBalanceAt(user.id, broker.id, "2024-01-31")).toBe(
      45000,
    );
  });

  it("is picked up by currentValues, the balance series and net worth", async () => {
    const { user, broker } = await setup();
    const row = await getAccount(user.id, broker.id, "2024-12-31");
    expect(
      (await currentValues(user.id, [row], "2024-12-31")).get(broker.id),
    ).toMatchObject({
      cash: 60000,
      total: 112000,
    });
    const series = await balanceSeries(
      user.id,
      broker.id,
      "2024-01-01",
      "2024-02-29",
      "month",
    );
    // trades are valued at cost until the first price, so the total stays at the deposit
    expect(series.map((p) => p.amount)).toEqual([100000, 100000]);

    const [net] = await netWorthSeries(user.id, {
      from: "2024-01-31",
      to: "2024-12-31",
      step: "month",
      today: "2024-12-31",
    });
    // Main is 1000.00 down, Broker 1120.00 up: net worth moved by the gain only.
    expect(net!.points[0]!.amount).toBe(0);
    expect(net!.points.at(-1)!.amount).toBe(12000);
  });

  it("feeds the dashboard cash balance, liquidity and the forecast", async () => {
    const { user, broker } = await setup();
    const view = (await accountBalances(user.id, "2024-12-31")).find(
      (a) => a.id === broker.id,
    )!;
    expect(view).toMatchObject({ cashBalance: 60000, balance: 112000 });
    const [chf] = await liquidity(user.id, "2024-12-31", undefined, true);
    // Main sent 1000.00 away (-1000.00), Broker's cash is 600.00
    expect(chf!.now.balance).toBe(-100000 + 60000);
    const projected = (await forecast(user.id, "2024-12-31", 30)).accounts.find(
      (a) => a.accountId === broker.id,
    );
    expect(projected?.startBalance).toBe(60000);
  });

  it("stays per user", async () => {
    const { user, broker } = await setup();
    const other = await createTestUser();
    await expect(
      accountValue(other.id, broker.id, "2024-12-31"),
    ).rejects.toThrow(/not found/i);
    const mine = await seedAccount(other.id, {
      type: "investment",
      tradesMoveCash: true,
    });
    expect((await accountValue(other.id, mine.id, "2024-12-31")).cash).toBe(0);
    expect((await accountValue(user.id, broker.id, "2024-12-31")).cash).toBe(
      60000,
    );
  });
});

describe("enabling trades move cash", () => {
  useTestDB();

  const inputOf = (view: Awaited<ReturnType<typeof getAccount>>) => ({
    institutionId: null,
    name: view.name,
    type: view.type,
    currency: view.currency,
    iban: view.iban,
    contractNumber: null,
    depositIban: null,
    openingBalance: view.openingBalance,
    openingDate: view.openingDate,
    noticeMonths: null,
    freeWithdrawal: null,
    freeWithdrawalPeriod: null,
    shareBps: view.shareBps,
    sharedWith: null,
    sortOrder: null,
    fillFromTransfers: view.fillFromTransfers,
    tradesMoveCash: view.tradesMoveCash,
  });

  it("is refused when the account already has imported transactions", async () => {
    const user = await createTestUser();
    const broker = await seedAccount(user.id, {
      type: "investment",
      iban: EXAMPLE_IBAN,
    });
    await seedImportedTransaction(user.id, broker.id, {
      bookingDate: "2024-01-02",
      amount: minor(-60000),
    });
    const view = await getAccount(user.id, broker.id, "2024-12-31");
    await expect(
      updateAccount(user.id, broker.id, {
        ...inputOf(view),
        tradesMoveCash: true,
      }),
    ).rejects.toThrow(/statement/i);
    expect(
      (await getAccount(user.id, broker.id, "2024-12-31")).tradesMoveCash,
    ).toBe(false);
  });

  it("is allowed without imported transactions, and other users' imports do not count", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, { type: "investment" });
    await seedImportedTransaction(other.id, theirs.id, {
      bookingDate: "2024-01-02",
      amount: minor(-60000),
    });
    const broker = await seedAccount(user.id, {
      type: "investment",
      iban: EXAMPLE_IBAN,
    });
    const view = await getAccount(user.id, broker.id, "2024-12-31");
    await updateAccount(user.id, broker.id, {
      ...inputOf(view),
      tradesMoveCash: true,
    });
    expect(
      (await getAccount(user.id, broker.id, "2024-12-31")).tradesMoveCash,
    ).toBe(true);
  });

  it("allows other edits of an account that has it on and later received an import", async () => {
    const { user, broker } = await setup();
    await seedImportedTransaction(user.id, broker.id, {
      bookingDate: "2024-01-05",
      amount: minor(-100),
    });
    const view = await getAccount(user.id, broker.id, "2024-12-31");
    await updateAccount(user.id, broker.id, {
      ...inputOf(view),
      name: "Renamed",
    });
    expect(await getAccount(user.id, broker.id, "2024-12-31")).toMatchObject({
      name: "Renamed",
      tradesMoveCash: true,
    });
  });
});
