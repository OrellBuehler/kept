import { afterEach, describe, expect, it } from "vitest";
import { parseFixed } from "$lib/quantity";
import { LedgerError } from "$lib/server/ledger";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import {
  getMarketDataSettings,
  getQuoteProvider,
  listMarketDataUserIds,
  listPrices,
  QuoteProviderError,
  refreshPrices,
  setMarketDataEnabled,
  setQuoteProvider,
  upsertFxRates,
  type QuoteProvider,
} from "./index";
import { fxRates, getDB } from "$lib/server/db";

useTestDB();
afterEach(() => setQuoteProvider(null));

interface Calls {
  history: [string, string, string][];
  fx: [string, string, string, string][];
}

function fakeProvider(
  over: Partial<QuoteProvider> = {},
  currency = "CHF",
): { provider: QuoteProvider; calls: Calls } {
  const calls: Calls = { history: [], fx: [] };
  const provider: QuoteProvider = {
    async history(symbol, from, to) {
      calls.history.push([symbol, from, to]);
      return {
        currency,
        points: [
          { date: from, price: parseFixed("100") },
          { date: to, price: parseFixed("101") },
        ],
      };
    },
    async fx(base, quote, from, to) {
      calls.fx.push([base, quote, from, to]);
      return [{ date: to, rate: parseFixed("0.9") }];
    },
    async search() {
      return [];
    },
    ...over,
  };
  return { provider, calls };
}

async function setup(opts: { symbol?: string | null; currency?: string } = {}) {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const security = seedSecurity(user.id, {
    symbol: opts.symbol === undefined ? "AAA.SW" : opts.symbol,
    currency: opts.currency ?? "CHF",
  });
  seedTrade(user.id, account.id, security.id, {
    date: "2024-01-10",
    amount: 1000,
  });
  setMarketDataEnabled(user.id, true);
  return { user, account, security };
}

describe("market data settings", () => {
  it("defaults to disabled and stores the opt-in per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    expect(getMarketDataSettings(a.id)).toEqual({
      enabled: false,
      lastRunAt: null,
      lastError: null,
    });
    setMarketDataEnabled(a.id, true);
    setMarketDataEnabled(a.id, true);
    expect(getMarketDataSettings(a.id).enabled).toBe(true);
    expect(getMarketDataSettings(b.id).enabled).toBe(false);
    expect(listMarketDataUserIds()).toEqual([a.id]);
    setMarketDataEnabled(a.id, false);
    expect(listMarketDataUserIds()).toEqual([]);
  });
});

describe("provider registry", () => {
  it("registers and clears a provider", () => {
    expect(getQuoteProvider()).toBeNull();
    const { provider } = fakeProvider();
    setQuoteProvider(provider);
    expect(getQuoteProvider()).toBe(provider);
  });
});

describe("refreshPrices", () => {
  it("refuses to run when disabled or without a provider", async () => {
    const user = await createTestUser();
    setQuoteProvider(fakeProvider().provider);
    await expect(refreshPrices(user.id, "2024-02-01")).rejects.toMatchObject({
      code: "conflict",
    });
    setMarketDataEnabled(user.id, true);
    setQuoteProvider(null);
    await expect(refreshPrices(user.id, "2024-02-01")).rejects.toBeInstanceOf(
      LedgerError,
    );
    expect(getMarketDataSettings(user.id).lastRunAt).toBeNull();
  });

  it("fetches from the first trade to today and records the run", async () => {
    const { user, security } = await setup();
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    const now = new Date("2024-02-01T12:00:00Z");
    const result = await refreshPrices(user.id, "2024-02-01", now);
    expect(calls.history).toEqual([["AAA.SW", "2024-01-10", "2024-02-01"]]);
    expect(calls.fx).toEqual([]);
    expect(result).toMatchObject({ securities: 1, prices: 2, errors: [] });
    expect(listPrices(user.id, security.id).map((p) => p.date)).toEqual([
      "2024-02-01",
      "2024-01-10",
    ]);
    expect(getMarketDataSettings(user.id)).toEqual({
      enabled: true,
      lastRunAt: now.getTime(),
      lastError: null,
    });
  });

  it("continues from the last fetched day, inclusive", async () => {
    const { user, security } = await setup();
    seedProviderPrice(user.id, security.id, "2024-01-10", "99");
    seedProviderPrice(user.id, security.id, "2024-01-25", "100");
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.history).toEqual([["AAA.SW", "2024-01-25", "2024-02-01"]]);
  });

  it("refetches the whole range after a split is recorded", async () => {
    const { user, account, security } = await setup();
    seedProviderPrice(user.id, security.id, "2024-01-10", "99");
    seedProviderPrice(user.id, security.id, "2024-01-25", "100");
    seedTrade(user.id, account.id, security.id, {
      date: "2024-01-20",
      side: "split",
      price: "0",
      amount: 0,
      split: { new: 2, old: 1 },
    });
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.history).toEqual([["AAA.SW", "2024-01-10", "2024-02-01"]]);
    // the old, unadjusted quotes are gone; the refetched ones replaced them
    expect(
      listPrices(user.id, security.id).map((p) => [p.date, p.price]),
    ).toEqual([
      ["2024-02-01", parseFixed("101")],
      ["2024-01-10", parseFixed("100")],
    ]);
  });

  it("refetches from the first trade when the history starts much later", async () => {
    const { user, security } = await setup();
    seedProviderPrice(user.id, security.id, "2024-01-25", "100");
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.history).toEqual([["AAA.SW", "2024-01-10", "2024-02-01"]]);
  });

  it("starts at the earliest trade across accounts", async () => {
    const { user, security } = await setup();
    const second = await seedAccount(user.id, { name: "Second" });
    seedTrade(user.id, second.id, security.id, {
      date: "2023-12-01",
      amount: 1000,
    });
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.history[0]![1]).toBe("2023-12-01");
  });

  it("skips zero and negative prices from the provider", async () => {
    const { user, security } = await setup();
    const { provider } = fakeProvider({
      async history() {
        return {
          currency: "CHF",
          points: [
            { date: "2024-01-10", price: parseFixed("0") },
            { date: "2024-01-11", price: parseFixed("-1") },
            { date: "2024-01-12", price: parseFixed("5") },
          ],
        };
      },
    });
    setQuoteProvider(provider);
    const result = await refreshPrices(user.id, "2024-02-01");
    expect(result.prices).toBe(1);
    expect(listPrices(user.id, security.id).map((p) => p.date)).toEqual([
      "2024-01-12",
    ]);
  });

  it("skips securities without a symbol or trades and trades dated after today", async () => {
    const { user, account } = await setup({ symbol: null });
    const future = seedSecurity(user.id, { name: "Later", symbol: "LATE.SW" });
    seedTrade(user.id, account.id, future.id, {
      date: "2030-01-01",
      amount: 1,
    });
    seedSecurity(user.id, { name: "Unused", symbol: "NONE.SW" });
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    const result = await refreshPrices(user.id, "2024-02-01");
    expect(calls.history).toEqual([]);
    expect(result.securities).toBe(0);
  });

  it("fetches FX for each foreign security currency and account currency pair", async () => {
    const { user } = await setup({ currency: "USD" });
    const { provider, calls } = fakeProvider({}, "USD");
    setQuoteProvider(provider);
    const result = await refreshPrices(user.id, "2024-02-01");
    expect(calls.fx).toEqual([["USD", "CHF", "2024-01-10", "2024-02-01"]]);
    expect(result).toMatchObject({ fxPairs: 1, fxRates: 1 });
    expect(getDB().select().from(fxRates).all()).toMatchObject([
      { base: "USD", quote: "CHF", date: "2024-02-01", source: "provider" },
    ]);
  });

  it("fetches FX for a manual-price security too, and continues from the last rate", async () => {
    const { user } = await setup({ symbol: null, currency: "USD" });
    upsertFxRates(user.id, [
      {
        base: "USD",
        quote: "CHF",
        date: "2024-01-10",
        rate: parseFixed("0.9"),
      },
      {
        base: "USD",
        quote: "CHF",
        date: "2024-01-30",
        rate: parseFixed("0.9"),
      },
    ]);
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.history).toEqual([]);
    expect(calls.fx).toEqual([["USD", "CHF", "2024-01-30", "2024-02-01"]]);
  });

  it("does not request FX for a security in the account currency", async () => {
    const { user } = await setup();
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.fx).toEqual([]);
  });

  it("records provider failures, keeps going and stores the last error", async () => {
    const { user, account } = await setup();
    const second = seedSecurity(user.id, { name: "Second", symbol: "BBB.SW" });
    seedTrade(user.id, account.id, second.id, {
      date: "2024-01-10",
      amount: 1,
    });
    const { provider } = fakeProvider({
      async history(symbol, from, to) {
        if (symbol === "AAA.SW") throw new QuoteProviderError("HTTP 503");
        return {
          currency: "CHF",
          points: [{ date: to, price: parseFixed("5") }],
        };
      },
    });
    setQuoteProvider(provider);
    const result = await refreshPrices(user.id, "2024-02-01");
    expect(result.securities).toBe(1);
    expect(result.prices).toBe(1);
    expect(result.errors).toEqual(["AAA.SW: HTTP 503"]);
    expect(getMarketDataSettings(user.id)).toMatchObject({
      lastError: "AAA.SW: HTTP 503",
    });
    expect(getMarketDataSettings(user.id).lastRunAt).not.toBeNull();
  });

  it("never stores the message of an unexpected error", async () => {
    const { user } = await setup();
    setQuoteProvider(
      fakeProvider({
        async history() {
          throw Object.assign(
            new Error("insert into trades (note) values (?) -- secret note"),
            { name: "DrizzleQueryError", params: ["secret note"] },
          );
        },
        async fx() {
          throw new Error("secret fx failure");
        },
      }).provider,
    );
    const result = await refreshPrices(user.id, "2024-02-01");
    const stored = getMarketDataSettings(user.id).lastError ?? "";
    expect(result.errors.length).toBeGreaterThan(0);
    for (const text of [stored, ...result.errors]) {
      expect(text).not.toContain("secret");
      expect(text).not.toContain("insert into");
    }
    expect(stored).toContain("AAA.SW: DrizzleQueryError");
  });

  it("clears the last error after a clean run", async () => {
    const { user } = await setup();
    setQuoteProvider(
      fakeProvider({
        async history() {
          throw new QuoteProviderError("boom");
        },
      }).provider,
    );
    await refreshPrices(user.id, "2024-02-01");
    expect(getMarketDataSettings(user.id).lastError).toBe("AAA.SW: boom");
    setQuoteProvider(fakeProvider().provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(getMarketDataSettings(user.id).lastError).toBeNull();
  });

  it("rejects prices quoted in another currency than the security's", async () => {
    const { user, security } = await setup();
    setQuoteProvider(fakeProvider({}, "USD").provider);
    const result = await refreshPrices(user.id, "2024-02-01");
    expect(result.errors).toEqual(["AAA.SW: quoted in USD, expected CHF"]);
    expect(listPrices(user.id, security.id)).toEqual([]);
  });

  it("rejects invalid dates and ignores points outside the range", async () => {
    const { user, security } = await setup();
    setQuoteProvider(
      fakeProvider({
        async history() {
          return {
            currency: "CHF",
            points: [{ date: "2024-13-40", price: parseFixed("1") }],
          };
        },
      }).provider,
    );
    expect((await refreshPrices(user.id, "2024-02-01")).errors).toHaveLength(1);
    setQuoteProvider(
      fakeProvider({
        async history() {
          return {
            currency: "CHF",
            points: [
              { date: "2023-01-01", price: parseFixed("1") },
              { date: "2024-01-20", price: parseFixed("2") },
              { date: "2025-01-01", price: parseFixed("3") },
            ],
          };
        },
      }).provider,
    );
    await refreshPrices(user.id, "2024-02-01");
    expect(listPrices(user.id, security.id).map((p) => p.date)).toEqual([
      "2024-01-20",
    ]);
  });

  it("ignores non-positive FX rates", async () => {
    const { user } = await setup({ currency: "USD" });
    setQuoteProvider(
      fakeProvider(
        {
          async fx() {
            return [{ date: "2024-02-01", rate: parseFixed("0") }];
          },
        },
        "USD",
      ).provider,
    );
    expect((await refreshPrices(user.id, "2024-02-01")).fxRates).toBe(0);
  });

  it("only touches the requesting user's data", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    const otherAccount = await seedAccount(other.id);
    const otherSecurity = seedSecurity(other.id, { symbol: "OTH.SW" });
    seedTrade(other.id, otherAccount.id, otherSecurity.id, { amount: 1 });
    setMarketDataEnabled(other.id, true);
    const { provider, calls } = fakeProvider();
    setQuoteProvider(provider);
    await refreshPrices(user.id, "2024-02-01");
    expect(calls.history.map((c) => c[0])).toEqual(["AAA.SW"]);
    expect(listPrices(other.id, otherSecurity.id)).toEqual([]);
    expect(getMarketDataSettings(other.id).lastRunAt).toBeNull();
  });
});
