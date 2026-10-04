import { afterEach, describe, expect, it } from "vitest";
import {
  getMarketDataSettings,
  setMarketDataEnabled,
  setQuoteProvider,
  type QuoteProvider,
} from "$lib/server/investments";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;

const act = (name: keyof typeof actions, user: User, form = {}) =>
  outcome(() => actions[name]!(createTestEvent({ user, form }) as never));

const provider: QuoteProvider = {
  history: async () => ({
    currency: "CHF",
    points: [{ date: "2024-02-01" as string, price: 6_000_000_000 as never }],
  }),
  fx: async () => [],
  search: async () => [],
};

describe("settings/market-data", () => {
  useTestDB();
  afterEach(() => setQuoteProvider(null));

  it("loads the defaults: off, never run, no provider", async () => {
    const u = await createTestUser();
    expect(await load(createTestEvent({ user: u }) as never)).toEqual({
      settings: { enabled: false, lastRunAt: null, lastError: null },
      providerAvailable: false,
    });
  });

  it("is opt-in and can be turned off again", async () => {
    const u = await createTestUser();
    expect(await act("save", u, { enabled: "on" })).toMatchObject({
      type: "return",
      value: { success: true, enabled: true },
    });
    expect(getMarketDataSettings(u.id).enabled).toBe(true);
    expect(await act("save", u, {})).toMatchObject({
      type: "return",
      value: { success: true, enabled: false },
    });
    expect(getMarketDataSettings(u.id).enabled).toBe(false);
  });

  it("settings are per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await act("save", a, { enabled: "on" });
    expect(getMarketDataSettings(b.id).enabled).toBe(false);
  });

  it("refuses to refresh while market data is off", async () => {
    const u = await createTestUser();
    setQuoteProvider(provider);
    expect(await act("refresh", u)).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { form: [expect.any(String)] } },
    });
  });

  it("refreshes and returns the summary", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { type: "investment" });
    const sec = seedSecurity(u.id, { symbol: "AAA.SW" });
    seedTrade(u.id, acc.id, sec.id, { date: "2024-01-15", amount: 100000 });
    seedProviderPrice(u.id, sec.id, "2024-01-20", "100");
    setMarketDataEnabled(u.id, true);
    setQuoteProvider(provider);
    const r = await act("refresh", u);
    expect(r).toMatchObject({
      type: "return",
      value: {
        success: true,
        action: "refresh",
        result: { securities: 1, errors: [] },
      },
    });
    expect(getMarketDataSettings(u.id).lastRunAt).not.toBeNull();
  });
});
