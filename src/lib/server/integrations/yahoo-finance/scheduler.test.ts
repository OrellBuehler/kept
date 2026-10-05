import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFixed } from "$lib/quantity";
import {
  getMarketDataSettings,
  getQuoteProvider,
  listPrices,
  setMarketDataEnabled,
  setQuoteProvider,
  type QuoteProvider,
} from "$lib/server/investments";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedSecurity, seedTrade } from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import { registerMarketData, unregisterMarketData } from "./index";
import { runRefresh, startScheduler } from "./scheduler";

useTestDB();
afterEach(() => {
  unregisterMarketData();
  setQuoteProvider(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function provider(over: Partial<QuoteProvider> = {}): {
  provider: QuoteProvider;
  symbols: string[];
} {
  const symbols: string[] = [];
  return {
    symbols,
    provider: {
      async history(symbol, _from, to) {
        symbols.push(symbol);
        return {
          currency: "CHF",
          points: [{ date: to, price: parseFixed("100") }],
        };
      },
      async fx() {
        return [];
      },
      async search() {
        return [];
      },
      ...over,
    },
  };
}

async function seedUser(symbol: string, enabled: boolean) {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const security = await seedSecurity(user.id, { symbol, currency: "CHF" });
  await seedTrade(user.id, account.id, security.id, {
    date: "2024-01-10",
    amount: 1000,
  });
  await setMarketDataEnabled(user.id, enabled);
  return { user, security };
}

describe("market data scheduler", () => {
  it("refreshes every opted-in user and skips the others", async () => {
    const on = await seedUser("ON.SW", true);
    await seedUser("OFF.SW", false);
    const fake = provider();
    setQuoteProvider(fake.provider);

    await runRefresh();

    expect(fake.symbols).toEqual(["ON.SW"]);
    expect(await listPrices(on.user.id, on.security.id)).toHaveLength(1);
    expect((await getMarketDataSettings(on.user.id)).lastRunAt).not.toBeNull();
  });

  it("a user whose refresh throws does not stop the others", async () => {
    const first = await seedUser("A.SW", true);
    const second = await seedUser("B.SW", true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = provider();
    let calls = 0;
    setQuoteProvider({
      ...fake.provider,
      async history(symbol, from, to) {
        calls += 1;
        if (symbol === "A.SW") throw new Error("boom");
        return fake.provider.history(symbol, from, to);
      },
    });

    await runRefresh();

    expect(calls).toBe(2);
    expect((await getMarketDataSettings(first.user.id)).lastError).toBe(
      "A.SW: Error",
    );
    expect(await listPrices(second.user.id, second.security.id)).toHaveLength(
      1,
    );
  });

  it("logs a refresh that cannot run without leaking details", async () => {
    await seedUser("A.SW", true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setQuoteProvider(null);

    await runRefresh();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      "market data: refresh failed",
      "invalid",
    ]);
  });

  it("runs on a timer, does not overlap and can be stopped", async () => {
    await seedUser("A.SW", true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    setQuoteProvider(
      provider({
        async history(_s, _f, to) {
          calls += 1;
          await gate;
          return {
            currency: "CHF",
            points: [{ date: to, price: parseFixed("1") }],
          };
        },
      }).provider,
    );

    vi.useFakeTimers();
    const stop = startScheduler({
      intervalMs: 1000,
      firstRunDelayMs: 10,
      jitterMs: 0,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
  });
});

describe("registerMarketData", () => {
  it("registers the provider once and unregisters it", () => {
    registerMarketData();
    const registered = getQuoteProvider();
    expect(registered).not.toBeNull();
    registerMarketData();
    expect(getQuoteProvider()).toBe(registered);
    unregisterMarketData();
    expect(getQuoteProvider()).toBeNull();
  });
});
