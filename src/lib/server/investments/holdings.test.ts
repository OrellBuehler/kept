import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { parseFixed } from "$lib/quantity";
import {
  accountBalances,
  earliestDataDate,
  netWorthSeries,
} from "$lib/server/dashboard";
import {
  accountBalanceAt,
  accountValue,
  archiveAccount,
  balanceSeries,
  createSnapshot,
  currentBalance,
  getAccount,
  listAccounts,
} from "$lib/server/ledger";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  seedManualPrice,
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import {
  seedAccount,
  seedImport,
  seedImportedTransaction,
} from "$lib/testing/ledger";
import {
  latestHoldingsActivity,
  loadHoldingsInputs,
  upsertFxRates,
} from "./index";

useTestDB();

const TODAY = "2026-10-15";
const m = minor;

async function setup() {
  const user = await createTestUser();
  const account = await seedAccount(user.id, {
    type: "investment",
    openingBalance: m(50000),
  });
  const security = await seedSecurity(user.id);
  await seedTrade(user.id, account.id, security.id, {
    date: "2026-01-10",
    qty: "10",
    price: "100",
    amount: 100500,
    fees: 500,
  });
  await seedProviderPrice(user.id, security.id, "2026-10-14", "120");
  return { user, account, security };
}

describe("balance with holdings", () => {
  it("adds the holdings value to the cash balance without touching cash", async () => {
    const { user, account } = await setup();
    expect(await currentBalance(user.id, account.id, TODAY)).toBe(
      50000 + 120000,
    );
    expect(await accountBalanceAt(user.id, account.id, TODAY)).toBe(50000);
    expect((await getAccount(user.id, account.id, TODAY)).balance).toBe(170000);
  });

  it("counts cash transactions and snapshots on top", async () => {
    const { user, account } = await setup();
    await seedImportedTransaction(user.id, account.id, {
      bookingDate: "2026-03-01",
      amount: m(-1000),
    });
    expect(await currentBalance(user.id, account.id, TODAY)).toBe(169000);
    await createSnapshot(user.id, account.id, {
      date: "2026-06-01",
      amount: m(7000),
      note: null,
    });
    expect(await currentBalance(user.id, account.id, TODAY)).toBe(
      7000 + 120000,
    );
  });

  it("ignores trades after the date", async () => {
    const { user, account, security } = await setup();
    await seedTrade(user.id, account.id, security.id, {
      date: "2026-12-01",
      qty: "5",
      amount: 60000,
    });
    expect(await currentBalance(user.id, account.id, TODAY)).toBe(170000);
    expect(await currentBalance(user.id, account.id, "2026-12-31")).toBe(
      50000 + 15 * 10000,
    );
  });

  it("splits cash, holdings and positions in accountValue", async () => {
    const { user, account, security } = await setup();
    const v = await accountValue(user.id, account.id, TODAY);
    expect(v).toMatchObject({
      cash: 50000,
      holdings: 120000,
      total: 170000,
      estimated: false,
    });
    expect(v.positions).toHaveLength(1);
    expect(v.positions[0]).toMatchObject({
      securityId: security.id,
      name: security.name,
      quantity: parseFixed("10"),
      price: parseFixed("120"),
      priceDate: "2026-10-14",
      priceSource: "provider",
      value: 120000,
      cost: 100500,
      gain: 19500,
    });
  });

  it("returns an empty breakdown for an account without trades", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id, { openingBalance: m(900) });
    expect(await accountValue(user.id, account.id, TODAY)).toEqual({
      cash: 900,
      holdings: 0,
      portfolios: 0,
      total: 900,
      positions: [],
      estimated: false,
    });
  });

  it("lets a manual price win in the account value", async () => {
    const { user, account, security } = await setup();
    await seedManualPrice(user.id, security.id, "2026-10-14", "130");
    expect((await accountValue(user.id, account.id, TODAY)).holdings).toBe(
      130000,
    );
  });

  it("converts foreign securities and flags a missing rate", async () => {
    const { user, account } = await setup();
    const usd = await seedSecurity(user.id, {
      name: "Dollar Stock",
      currency: "USD",
    });
    await seedTrade(user.id, account.id, usd.id, {
      date: "2026-02-01",
      qty: "2",
      price: "50",
      amount: 9000,
    });
    await seedProviderPrice(user.id, usd.id, "2026-10-14", "60");

    const missing = await accountValue(user.id, account.id, TODAY);
    expect(missing.estimated).toBe(true);
    expect(missing.holdings).toBe(120000 + 9000);

    await upsertFxRates(user.id, [
      {
        base: "USD",
        quote: "CHF",
        date: "2026-10-13",
        rate: parseFixed("0.8"),
      },
    ]);
    const priced = await accountValue(user.id, account.id, TODAY);
    expect(priced.estimated).toBe(false);
    expect(priced.holdings).toBe(120000 + 9600);
  });

  it("includes holdings in balance series", async () => {
    const { user, account } = await setup();
    const series = await balanceSeries(
      user.id,
      account.id,
      "2026-10-13",
      TODAY,
      "day",
    );
    expect(series.map((p) => p.amount)).toEqual([
      50000 + 100000,
      50000 + 120000,
      50000 + 120000,
    ]);
  });

  it("includes holdings in the account list and its share", async () => {
    const { user, account } = await setup();
    const list = await listAccounts(user.id, TODAY);
    expect(list[0]).toMatchObject({ id: account.id, balance: 170000 });
    const shared = await seedAccount(user.id, {
      name: "Shared",
      shareBps: 5000,
    });
    const sec = await seedSecurity(user.id, { name: "S" });
    await seedTrade(user.id, shared.id, sec.id, {
      amount: 100000,
      price: "100",
    });
    expect(await getAccount(user.id, shared.id, TODAY)).toMatchObject({
      balance: 100000,
      shareBalance: 50000,
    });
  });

  it("never mixes in another user's holdings, prices or rates", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const otherAccount = await seedAccount(other.id);
    expect(
      (await accountValue(other.id, otherAccount.id, TODAY)).positions,
    ).toEqual([]);
    expect((await loadHoldingsInputs(other.id, [account.id], TODAY)).size).toBe(
      0,
    );
    expect((await loadHoldingsInputs(user.id, [account.id], TODAY)).size).toBe(
      1,
    );
    expect(
      (await netWorthSeries(other.id, { today: TODAY }))[0]!.points.every(
        (p) => p.amount === 0,
      ),
    ).toBe(true);
    await expect(accountValue(other.id, account.id, TODAY)).rejects.toThrow(
      /not found/,
    );
  });

  it("batches several accounts", async () => {
    const { user, account } = await setup();
    const second = await seedAccount(user.id, { name: "Second" });
    const sec = await seedSecurity(user.id, { name: "S2" });
    await seedTrade(user.id, second.id, sec.id, { amount: 1000 });
    const inputs = await loadHoldingsInputs(
      user.id,
      [account.id, second.id],
      TODAY,
    );
    expect([...inputs.keys()].sort()).toEqual([account.id, second.id].sort());
    expect(inputs.get(second.id)!.trades).toHaveLength(1);
    expect(inputs.get(account.id)!.securities).toHaveLength(1);
  });
});

describe("net worth with holdings", () => {
  it("sums holdings per currency and excludes archived accounts", async () => {
    const { user, account } = await setup();
    const usdAccount = await seedAccount(user.id, {
      name: "Dollar",
      currency: "USD",
      openingBalance: m(1000),
    });
    const usdSecurity = await seedSecurity(user.id, {
      name: "Dollar Stock",
      currency: "USD",
    });
    await seedTrade(user.id, usdAccount.id, usdSecurity.id, {
      date: "2026-02-01",
      qty: "1",
      price: "300",
      amount: 30000,
    });
    const archived = await seedAccount(user.id, {
      name: "Gone",
      openingBalance: m(5),
    });
    const archivedSecurity = await seedSecurity(user.id, { name: "Gone" });
    await seedTrade(user.id, archived.id, archivedSecurity.id, {
      amount: 99999,
    });
    await archiveAccount(user.id, archived.id);

    const series = await netWorthSeries(user.id, {
      today: TODAY,
      from: "2026-10-13",
      step: "day",
    });
    expect(series.map((s) => s.currency)).toEqual(["CHF", "USD"]);
    expect(series[0]!.points.map((p) => p.amount)).toEqual([
      50000 + 100000,
      50000 + 120000,
      50000 + 120000,
    ]);
    expect(series[1]!.points.at(-1)!.amount).toBe(1000 + 30000);
    expect(account.id).toBeTruthy();
  });

  it("matches the account balances at the end of the series", async () => {
    const { user } = await setup();
    const series = await netWorthSeries(user.id, { today: TODAY });
    const total = (await accountBalances(user.id, TODAY)).reduce(
      (sum, a) => sum + a.balance,
      0,
    );
    expect(series[0]!.points.at(-1)!.amount).toBe(total);
  });

  it("counts shares of holdings with the share basis", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id, { shareBps: 5000 });
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-10-01",
      amount: 100000,
    });
    const series = await netWorthSeries(user.id, {
      today: TODAY,
      basis: "share",
      step: "day",
      from: TODAY,
    });
    expect(series[0]!.points.at(-1)!.amount).toBe(50000);
  });
});

describe("earliestDataDate", () => {
  it("considers trade dates", async () => {
    const user = await createTestUser();
    expect(await earliestDataDate(user.id)).toBeNull();
    const account = await seedAccount(user.id);
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, account.id, sec.id, {
      date: "2023-05-05",
      amount: 1,
    });
    expect(await earliestDataDate(user.id)).toBe("2023-05-05");
    await seedImportedTransaction(user.id, account.id, {
      bookingDate: "2024-01-01",
    });
    expect(await earliestDataDate(user.id)).toBe("2023-05-05");
  });

  it("counts trades of archived accounts but not other users' trades", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const archived = await seedAccount(user.id);
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, archived.id, sec.id, {
      date: "2020-01-01",
      amount: 1,
    });
    await archiveAccount(user.id, archived.id);
    const otherAccount = await seedAccount(other.id);
    const otherSec = await seedSecurity(other.id);
    await seedTrade(other.id, otherAccount.id, otherSec.id, {
      date: "2019-01-01",
      amount: 1,
    });
    expect(await earliestDataDate(user.id)).toBe("2020-01-01");
  });
});

describe("staleness with holdings", () => {
  it("does not flag an old import when a held security was priced manually recently", async () => {
    const { user, account, security } = await setup();
    await seedManualPrice(user.id, security.id, "2026-10-14", "121");
    await seedImport(user.id, account.id, {
      createdAt: new Date("2026-06-01T12:00:00"),
    });
    const view = (await accountBalances(user.id, TODAY)).find(
      (a) => a.id === account.id,
    )!;
    expect(view).toMatchObject({ stale: false, staleDays: 1 });
  });

  it("does not flag an old import when there was a recent trade", async () => {
    const { user, account, security } = await setup();
    await seedTrade(user.id, account.id, security.id, {
      date: "2026-10-10",
      qty: "1",
      price: "100",
      amount: 100,
    });
    await seedImport(user.id, account.id, {
      createdAt: new Date("2026-06-01T12:00:00"),
    });
    expect((await accountBalances(user.id, TODAY))[0]).toMatchObject({
      stale: false,
      staleDays: 5,
    });
  });

  it("stays stale with an old import and daily fetched prices", async () => {
    const { user, account, security } = await setup();
    for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      await seedProviderPrice(user.id, security.id, d, "120");
    }
    await seedImport(user.id, account.id, {
      createdAt: new Date("2026-04-15T12:00:00"),
    });
    const view = (await accountBalances(user.id, TODAY)).find(
      (a) => a.id === account.id,
    )!;
    expect(view).toMatchObject({ stale: true });
    expect(view.staleDays).toBe(183);
  });

  it("ignores manual prices of a fully sold security", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-01-01",
      qty: "5",
      amount: 500,
    });
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-02-01",
      side: "sell",
      qty: "5",
      amount: 500,
    });
    await seedManualPrice(user.id, sec.id, "2026-10-14", "10");
    await seedImport(user.id, account.id, {
      createdAt: new Date("2026-06-01T12:00:00"),
    });
    expect((await accountBalances(user.id, TODAY))[0]).toMatchObject({
      stale: true,
      staleDays: 136,
    });
  });

  it("does not count future-dated manual prices or another account's", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const other = await seedAccount(user.id, { name: "Other" });
    const sec = await seedSecurity(user.id);
    const otherSec = await seedSecurity(user.id, { name: "Other sec" });
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-01-01",
      amount: 1,
    });
    await seedTrade(user.id, other.id, otherSec.id, {
      date: "2026-01-01",
      amount: 1,
    });
    await seedManualPrice(user.id, sec.id, "2026-12-01", "10");
    await seedManualPrice(user.id, otherSec.id, "2026-10-14", "10");
    const by = Object.fromEntries(
      (await accountBalances(user.id, TODAY)).map((a) => [a.name, a]),
    );
    expect(by.Main!.stale).toBe(true);
    expect(by.Other!.stale).toBe(false);
  });

  it("yields one date per account without multiplying rows by prices", async () => {
    const { user, account, security } = await setup();
    const second = await seedAccount(user.id, { name: "Second" });
    await seedTrade(user.id, second.id, security.id, {
      date: "2026-02-01",
      amount: 1,
    });
    await seedTrade(user.id, account.id, security.id, {
      date: "2026-03-01",
      amount: 1,
    });
    await seedManualPrice(user.id, security.id, "2026-09-01", "1");
    expect(
      await latestHoldingsActivity(user.id, [account.id, second.id], TODAY),
    ).toEqual(
      new Map([
        [account.id, "2026-09-01"],
        [second.id, "2026-09-01"],
      ]),
    );
    const another = await createTestUser();
    expect(
      (await latestHoldingsActivity(another.id, [account.id, second.id], TODAY))
        .size,
    ).toBe(0);
  });

  it("treats a security as held after a split even when sells exceed the raw quantity", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-01-01",
      qty: "10",
      amount: 1,
    });
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-02-01",
      side: "split",
      qty: "2",
      price: "0",
      amount: 0,
    });
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-03-01",
      side: "sell",
      qty: "15",
      amount: 1,
    });
    await seedManualPrice(user.id, sec.id, "2026-09-01", "1");
    expect(
      (await latestHoldingsActivity(user.id, [account.id], TODAY)).get(
        account.id,
      ),
    ).toBe("2026-09-01");
  });

  it("stays stale when prices and trades are old too", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const sec = await seedSecurity(user.id);
    await seedTrade(user.id, account.id, sec.id, {
      date: "2026-01-01",
      amount: 1,
    });
    await seedProviderPrice(user.id, sec.id, "2026-03-01", "10");
    await seedImport(user.id, account.id, {
      createdAt: new Date("2026-06-01T12:00:00"),
    });
    const view = (await accountBalances(user.id, TODAY))[0]!;
    expect(view).toMatchObject({ stale: true, staleDays: 136 });
  });

  it("is not affected by manual prices of securities the account does not hold", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const held = await seedSecurity(user.id, { name: "Held" });
    const unheld = await seedSecurity(user.id, { name: "Unheld" });
    await seedTrade(user.id, account.id, held.id, {
      date: "2026-01-01",
      amount: 1,
    });
    await seedManualPrice(user.id, unheld.id, "2026-10-14", "10");
    await seedImport(user.id, account.id, {
      createdAt: new Date("2026-06-01T12:00:00"),
    });
    expect((await accountBalances(user.id, TODAY))[0]!.stale).toBe(true);
  });

  it("gives an account with only a recent trade a staleness and data", async () => {
    const user = await createTestUser();
    const fresh = await seedAccount(user.id, { name: "Fresh" });
    const old = await seedAccount(user.id, { name: "Old" });
    const sec = await seedSecurity(user.id, { name: "Sec" });
    await seedTrade(user.id, fresh.id, sec.id, {
      date: "2026-10-14",
      amount: 1,
    });
    await seedTrade(user.id, old.id, sec.id, { date: "2026-01-01", amount: 1 });
    const by = Object.fromEntries(
      (await accountBalances(user.id, TODAY)).map((a) => [a.name, a]),
    );
    expect(by.Fresh).toMatchObject({
      noData: false,
      stale: false,
      staleDays: 1,
    });
    expect(by.Old).toMatchObject({ noData: false, stale: true });
  });
});
