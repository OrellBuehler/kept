import { afterEach, describe, expect, it } from "vitest";
import { parseFixed } from "$lib/quantity";
import {
  getSecurity,
  listPrices,
  PRICE_LIST_LIMIT,
  QuoteProviderError,
  upsertProviderPrices,
  listSecurities,
  setMarketDataEnabled,
  setQuoteProvider,
  type QuoteProvider,
} from "$lib/server/investments";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  seedManualPrice,
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;

const run = (
  name: keyof typeof actions,
  user: User,
  form: Record<string, string> = {},
) => outcome(() => actions[name]!(createTestEvent({ user, form }) as never));
const loadAs = (user: User, query = "") =>
  outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://localhost/investments${query}`,
      }) as never,
    ),
  );
const loaded = async (user: User, query = "") =>
  ((await loadAs(user, query)) as { value: LoadData }).value;

const securityForm = {
  name: "Example World ETF",
  kind: "etf",
  isin: "IE00B4L5Y983",
  symbol: "swda.sw",
  currency: "chf",
};

function fakeProvider(search: QuoteProvider["search"]): QuoteProvider {
  return {
    history: async () => ({ currency: "CHF", points: [] }),
    fx: async () => [],
    search,
  };
}

describe("investments page", () => {
  useTestDB();
  afterEach(() => setQuoteProvider(null));

  it("load is empty for a new user", async () => {
    const u = await createTestUser();
    expect(await loaded(u)).toEqual({
      overview: { totals: [], securities: [] },
      securities: [],
      marketData: { enabled: false, canLookup: false },
      priceHistory: null,
    });
  });

  it("load returns securities, positions and the price history of one security", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id, { type: "investment" });
    const sec = seedSecurity(u.id);
    seedTrade(u.id, acc.id, sec.id, { qty: "2", price: "50", amount: 10000 });
    seedManualPrice(u.id, sec.id, "2024-02-01", "60");
    seedProviderPrice(u.id, sec.id, "2024-02-01", "59");

    const v = await loaded(u, `?prices=${sec.id}`);
    expect(v.securities.map((s: { id: string }) => s.id)).toEqual([sec.id]);
    expect(v.overview.securities).toHaveLength(1);
    expect(v.priceHistory?.security.id).toBe(sec.id);
    expect(
      v.priceHistory?.prices.map((p: { source: string }) => p.source).sort(),
    ).toEqual(["manual", "provider"]);
  });

  it("limits the price history and can show all of it", async () => {
    const u = await createTestUser();
    const sec = seedSecurity(u.id);
    upsertProviderPrices(
      u.id,
      sec.id,
      Array.from({ length: 400 }, (_, i) => ({
        date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10),
        price: parseFixed("1"),
      })),
    );
    const limited = await loaded(u, `?prices=${sec.id}`);
    expect(limited.priceHistory).toMatchObject({ total: 400 });
    expect(limited.priceHistory?.prices).toHaveLength(PRICE_LIST_LIMIT);
    const all = await loaded(u, `?prices=${sec.id}&all=1`);
    expect(all.priceHistory?.prices).toHaveLength(400);
  });

  it("404s a malformed prices parameter", async () => {
    const u = await createTestUser();
    expect(await loadAs(u, `?prices=${"x".repeat(100)}`)).toEqual({
      type: "error",
      status: 404,
    });
  });

  it("reports whether a lookup is possible", async () => {
    const u = await createTestUser();
    setMarketDataEnabled(u.id, true);
    expect((await loaded(u)).marketData).toEqual({
      enabled: true,
      canLookup: false,
    });
    setQuoteProvider(fakeProvider(async () => []));
    expect((await loaded(u)).marketData.canLookup).toBe(true);
  });

  it("creates, edits and deletes a security", async () => {
    const u = await createTestUser();
    expect(await run("createSecurity", u, securityForm)).toMatchObject({
      type: "return",
      value: { success: true, action: "createSecurity" },
    });
    const [sec] = listSecurities(u.id);
    expect(sec).toMatchObject({ symbol: "SWDA.SW", currency: "CHF" });

    expect(
      await run("updateSecurity", u, {
        ...securityForm,
        securityId: sec!.id,
        name: "Renamed",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(getSecurity(u.id, sec!.id).name).toBe("Renamed");

    expect(
      await run("deleteSecurity", u, { securityId: sec!.id }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listSecurities(u.id)).toEqual([]);
  });

  it("validates securities and echoes the values", async () => {
    const u = await createTestUser();
    const r = await run("createSecurity", u, {
      ...securityForm,
      name: "",
      isin: "nope",
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "createSecurity",
        errors: { name: [expect.any(String)], isin: [expect.any(String)] },
        values: { name: "", isin: "nope" },
      },
    });
    expect(listSecurities(u.id)).toEqual([]);
  });

  it("refuses to delete a security that has trades", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const sec = seedSecurity(u.id);
    seedTrade(u.id, acc.id, sec.id, { amount: 100000 });
    expect(
      await run("deleteSecurity", u, { securityId: sec.id }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { form: [expect.any(String)] } },
    });
    expect(listSecurities(u.id)).toHaveLength(1);
  });

  it("sets a manual price and deletes it, but not a fetched one", async () => {
    const u = await createTestUser();
    const sec = seedSecurity(u.id);
    seedProviderPrice(u.id, sec.id, "2024-02-02", "59");
    expect(
      await run("setPrice", u, {
        securityId: sec.id,
        date: "2024-02-01",
        price: "60.5",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    const prices = listPrices(u.id, sec.id);
    const manual = prices.find((p) => p.source === "manual")!;
    const fetched = prices.find((p) => p.source === "provider")!;
    expect(manual.price).toBe(6_050_000_000);

    expect(await run("deletePrice", u, { priceId: fetched.id })).toMatchObject({
      type: "fail",
      status: 400,
    });
    expect(await run("deletePrice", u, { priceId: manual.id })).toMatchObject({
      type: "return",
      value: { success: true },
    });
    expect(listPrices(u.id, sec.id)).toHaveLength(1);
  });

  it("validates prices", async () => {
    const u = await createTestUser();
    const sec = seedSecurity(u.id);
    expect(
      await run("setPrice", u, {
        securityId: sec.id,
        date: "2024-02-30",
        price: "0",
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: { date: [expect.any(String)], price: [expect.any(String)] },
      },
    });
    expect(listPrices(u.id, sec.id)).toEqual([]);
  });

  describe("lookup", () => {
    it("returns matches from the provider once market data is on", async () => {
      const u = await createTestUser();
      setMarketDataEnabled(u.id, true);
      const queries: string[] = [];
      setQuoteProvider(
        fakeProvider(async (q) => {
          queries.push(q);
          return [
            {
              symbol: "AAA.SW",
              name: "Example Fund",
              currency: null,
              kind: "etf",
              isin: null,
            },
          ];
        }),
      );
      const r = await run("lookup", u, { q: " example " });
      expect(r).toMatchObject({
        type: "return",
        value: { success: true, matches: [{ symbol: "AAA.SW" }] },
      });
      expect(queries).toEqual(["example"]);
    });

    it("needs the opt-in, a provider and a search text", async () => {
      const u = await createTestUser();
      let called = false;
      const provider = fakeProvider(async () => {
        called = true;
        return [];
      });
      expect(await run("lookup", u, { q: "x" })).toMatchObject({
        type: "fail",
        data: { errors: { q: [expect.any(String)] } },
      });
      expect(await run("lookup", u, { q: "example" })).toMatchObject({
        type: "fail",
        data: { errors: { form: [expect.any(String)] } },
      });
      setQuoteProvider(provider);
      expect(await run("lookup", u, { q: "example" })).toMatchObject({
        type: "fail",
        data: { errors: { form: [expect.any(String)] } },
      });
      expect(called).toBe(false);
    });

    it("shows a provider error's message when the search fails", async () => {
      const u = await createTestUser();
      setMarketDataEnabled(u.id, true);
      setQuoteProvider(
        fakeProvider(async () => {
          throw new QuoteProviderError("The provider is busy.");
        }),
      );
      expect(await run("lookup", u, { q: "example" })).toMatchObject({
        type: "fail",
        status: 400,
        data: { errors: { form: ["The provider is busy."] } },
      });
    });

    it("hides the message of an unexpected error", async () => {
      const u = await createTestUser();
      setMarketDataEnabled(u.id, true);
      setQuoteProvider(
        fakeProvider(async () => {
          throw new Error("SQLITE: secret internals");
        }),
      );
      expect(await run("lookup", u, { q: "example" })).toMatchObject({
        type: "fail",
        status: 400,
        data: {
          errors: { form: ["The lookup failed. Please try again."] },
        },
      });
    });
  });

  describe("cross-user", () => {
    async function setup() {
      const a = await createTestUser();
      const b = await createTestUser();
      const sec = seedSecurity(a.id);
      const price = seedManualPrice(a.id, sec.id, "2024-02-01", "60");
      return { a, b, sec, price };
    }

    it("load never shows another user's securities and 404s their price history", async () => {
      const { b, sec } = await setup();
      expect((await loaded(b)).securities).toEqual([]);
      expect(await loadAs(b, `?prices=${sec.id}`)).toEqual({
        type: "error",
        status: 404,
      });
    });

    it("every action on A's rows is 404 for B and changes nothing", async () => {
      const { a, b, sec, price } = await setup();
      const attempts: [keyof typeof actions, Record<string, string>][] = [
        ["updateSecurity", { ...securityForm, securityId: sec.id }],
        ["deleteSecurity", { securityId: sec.id }],
        ["setPrice", { securityId: sec.id, date: "2024-02-02", price: "1" }],
        ["deletePrice", { priceId: price.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, b, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(getSecurity(a.id, sec.id).name).toBe("Example World ETF");
      expect(listPrices(a.id, sec.id)).toHaveLength(1);
    });
  });
});
