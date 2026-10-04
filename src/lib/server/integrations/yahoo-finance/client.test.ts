import { describe, expect, it } from "vitest";
import { parseFixed } from "$lib/quantity";
import { createYahooProvider, YahooError } from "./client";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  respond: (url: string) => Response | Promise<Response> | Error,
) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const out = await respond(url);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const ts = (iso: string) => Date.parse(iso) / 1000;

function chartBody(opts: {
  currency?: string;
  zone?: string;
  gmtoffset?: number;
  timestamps?: number[];
  close?: (number | null)[];
}) {
  return {
    chart: {
      result: [
        {
          meta: {
            currency: opts.currency,
            exchangeTimezoneName: opts.zone,
            gmtoffset: opts.gmtoffset,
          },
          timestamp: opts.timestamps,
          indicators: { quote: [{ close: opts.close ?? [] }] },
        },
      ],
      error: null,
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("history", () => {
  it("parses closes, skips nulls and requests the chart endpoint", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(
        chartBody({
          currency: "USD",
          zone: "America/New_York",
          timestamps: [
            ts("2024-03-04T14:30:00Z"),
            ts("2024-03-05T14:30:00Z"),
            ts("2024-03-06T14:30:00Z"),
          ],
          close: [100.5, null, 102.25],
        }),
      ),
    );
    const out = await createYahooProvider({ fetch }).history(
      "AAA",
      "2024-03-01",
      "2024-03-10",
    );

    expect(out.currency).toBe("USD");
    expect(out.points).toEqual([
      { date: "2024-03-04", price: parseFixed("100.5") },
      { date: "2024-03-06", price: parseFixed("102.25") },
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/AAA",
    );
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(Number(url.searchParams.get("period1"))).toBeLessThanOrEqual(
      ts("2024-03-01T00:00:00Z"),
    );
    expect(Number(url.searchParams.get("period2"))).toBeGreaterThanOrEqual(
      ts("2024-03-11T00:00:00Z"),
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/Mozilla/);
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("url-encodes the symbol", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(chartBody({ currency: "USD", timestamps: [], close: [] })),
    );
    await createYahooProvider({ fetch }).history(
      "^A/B C&x",
      "2024-03-01",
      "2024-03-02",
    );
    expect(calls[0]!.url).toContain("/chart/%5EA%2FB%20C%26x?");
  });

  it("maps timestamps to the exchange-local day", async () => {
    // 10:00 in Sydney (UTC+11 in March) is still the previous day in UTC.
    const { fetch } = fakeFetch(() =>
      json(
        chartBody({
          currency: "AUD",
          zone: "Australia/Sydney",
          gmtoffset: 39600,
          timestamps: [ts("2024-03-03T23:00:00Z")],
          close: [50],
        }),
      ),
    );
    const out = await createYahooProvider({ fetch }).history(
      "AAA.AX",
      "2024-03-01",
      "2024-03-10",
    );
    expect(out.points.map((p) => p.date)).toEqual(["2024-03-04"]);
  });

  it("uses gmtoffset when the zone name is missing or unknown", async () => {
    for (const zone of [undefined, "Not/AZone"]) {
      const { fetch } = fakeFetch(() =>
        json(
          chartBody({
            currency: "AUD",
            zone,
            gmtoffset: 39600,
            timestamps: [ts("2024-03-03T23:00:00Z")],
            close: [50],
          }),
        ),
      );
      const out = await createYahooProvider({ fetch }).history(
        "AAA.AX",
        "2024-03-01",
        "2024-03-10",
      );
      expect(out.points.map((p) => p.date)).toEqual(["2024-03-04"]);
    }
  });

  it("keeps the later bar when a day appears twice and drops days outside the range", async () => {
    const { fetch } = fakeFetch(() =>
      json(
        chartBody({
          currency: "USD",
          zone: "America/New_York",
          timestamps: [
            ts("2024-02-28T14:30:00Z"),
            ts("2024-03-04T14:30:00Z"),
            ts("2024-03-04T19:00:00Z"),
          ],
          close: [1, 10, 11],
        }),
      ),
    );
    const out = await createYahooProvider({ fetch }).history(
      "AAA",
      "2024-03-01",
      "2024-03-10",
    );
    expect(out.points).toEqual([
      { date: "2024-03-04", price: parseFixed("11") },
    ]);
  });

  it("returns no points when the range has no bars", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        chart: { result: [{ meta: { currency: "USD" } }], error: null },
      }),
    );
    const out = await createYahooProvider({ fetch }).history(
      "AAA",
      "2024-03-02",
      "2024-03-03",
    );
    expect(out).toEqual({ currency: "USD", points: [] });
  });

  it.each([
    ["GBp", "GBP"],
    ["GBX", "GBP"],
    ["ZAc", "ZAR"],
  ])("normalises %s to %s and divides prices by 100", async (from, to) => {
    const { fetch } = fakeFetch(() =>
      json(
        chartBody({
          currency: from,
          zone: "Europe/London",
          timestamps: [ts("2024-03-04T08:00:00Z"), ts("2024-03-05T08:00:00Z")],
          close: [1234.5, 0.5],
        }),
      ),
    );
    const out = await createYahooProvider({ fetch }).history(
      "AAA.L",
      "2024-03-01",
      "2024-03-10",
    );
    expect(out.currency).toBe(to);
    expect(out.points.map((p) => p.price)).toEqual([
      parseFixed("12.345"),
      parseFixed("0.005"),
    ]);
  });

  it("leaves a plain currency alone and upper-cases it", async () => {
    const { fetch } = fakeFetch(() =>
      json(chartBody({ currency: "chf", timestamps: [], close: [] })),
    );
    const out = await createYahooProvider({ fetch }).history(
      "AAA.SW",
      "2024-03-01",
      "2024-03-02",
    );
    expect(out.currency).toBe("CHF");
  });

  it("fails when the quote currency is missing", async () => {
    const { fetch } = fakeFetch(() =>
      json(chartBody({ timestamps: [], close: [] })),
    );
    await expect(
      createYahooProvider({ fetch }).history("AAA", "2024-03-01", "2024-03-02"),
    ).rejects.toThrow(/currency/);
  });
});

describe("fx", () => {
  it("requests the pair symbol and returns rates", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(
        chartBody({
          currency: "CHF",
          zone: "Europe/London",
          timestamps: [ts("2024-03-04T00:00:00Z")],
          close: [0.8821],
        }),
      ),
    );
    const out = await createYahooProvider({ fetch }).fx(
      "USD",
      "CHF",
      "2024-03-01",
      "2024-03-10",
    );
    expect(new URL(calls[0]!.url).pathname).toBe(
      "/v8/finance/chart/USDCHF%3DX",
    );
    expect(out).toEqual([{ date: "2024-03-04", rate: parseFixed("0.8821") }]);
  });

  it("rejects a pair quoted in another currency", async () => {
    const { fetch } = fakeFetch(() =>
      json(chartBody({ currency: "EUR", timestamps: [], close: [] })),
    );
    await expect(
      createYahooProvider({ fetch }).fx(
        "USD",
        "CHF",
        "2024-03-01",
        "2024-03-02",
      ),
    ).rejects.toThrow(/different currency/);
  });

  it("rejects malformed currency codes without a request", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    await expect(
      createYahooProvider({ fetch }).fx(
        "US/D",
        "CHF",
        "2024-03-01",
        "2024-03-02",
      ),
    ).rejects.toBeInstanceOf(YahooError);
    expect(calls).toHaveLength(0);
  });
});

describe("search", () => {
  it("maps quote types to kinds and requests the search endpoint", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        quotes: [
          {
            symbol: "AAA",
            shortname: "Alpha Short",
            longname: "Alpha Corp",
            quoteType: "EQUITY",
          },
          { symbol: "BBB.SW", shortname: "Beta ETF", quoteType: "ETF" },
          {
            symbol: "CCC",
            shortname: "Gamma Fund",
            quoteType: "MUTUALFUND",
            isin: "IE00B4L5Y983",
          },
          { symbol: "DDD=X", quoteType: "CURRENCY" },
          { shortname: "no symbol", quoteType: "EQUITY" },
        ],
      }),
    );
    const out = await createYahooProvider({ fetch }).search("alpha & co");

    expect(out).toEqual([
      {
        symbol: "AAA",
        name: "Alpha Corp",
        currency: null,
        kind: "stock",
        isin: null,
      },
      {
        symbol: "BBB.SW",
        name: "Beta ETF",
        currency: null,
        kind: "etf",
        isin: null,
      },
      {
        symbol: "CCC",
        name: "Gamma Fund",
        currency: null,
        kind: "fund",
        isin: "IE00B4L5Y983",
      },
      {
        symbol: "DDD=X",
        name: "DDD=X",
        currency: null,
        kind: null,
        isin: null,
      },
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://query2.finance.yahoo.com/v1/finance/search",
    );
    expect(url.searchParams.get("q")).toBe("alpha & co");
    expect(url.searchParams.get("quotesCount")).toBe("10");
    expect(url.searchParams.get("newsCount")).toBe("0");
  });

  it("returns an empty list when there are no quotes", async () => {
    const { fetch } = fakeFetch(() => json({}));
    expect(await createYahooProvider({ fetch }).search("zzz")).toEqual([]);
  });

  it("fails on a malformed body", async () => {
    const { fetch } = fakeFetch(() => json({ quotes: "nope" }));
    await expect(createYahooProvider({ fetch }).search("x")).rejects.toThrow(
      /unexpected response/,
    );
  });
});

describe("errors", () => {
  const history = (fetch: typeof globalThis.fetch) =>
    createYahooProvider({ fetch }).history("AAA", "2024-03-01", "2024-03-02");

  it("reports a chart.error from a 404", async () => {
    const { fetch } = fakeFetch(() =>
      json(
        {
          chart: {
            result: null,
            error: {
              code: "Not Found",
              description: "No data found, symbol may be delisted",
            },
          },
        },
        404,
      ),
    );
    await expect(history(fetch)).rejects.toThrow(/symbol may be delisted/);
  });

  it("reports a chart.error from a 200", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        chart: {
          result: null,
          error: { code: "Bad Request", description: "Invalid input" },
        },
      }),
    );
    await expect(history(fetch)).rejects.toThrow(/Invalid input/);
  });

  it("reports an empty result", async () => {
    const { fetch } = fakeFetch(() =>
      json({ chart: { result: [], error: null } }),
    );
    await expect(history(fetch)).rejects.toMatchObject({ code: "no_data" });
  });

  it("reports rate limiting", async () => {
    const { fetch } = fakeFetch(
      () => new Response("Too Many Requests", { status: 429 }),
    );
    await expect(history(fetch)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("reports other HTTP failures with the status", async () => {
    const { fetch } = fakeFetch(() => new Response("oops", { status: 503 }));
    await expect(history(fetch)).rejects.toThrow(/HTTP 503/);
  });

  it("reports a body that is not JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(history(fetch)).rejects.toMatchObject({ code: "invalid" });
  });

  it("reports JSON of the wrong shape", async () => {
    const { fetch } = fakeFetch(() =>
      json({ chart: { result: [{ meta: {}, timestamp: ["x"] }] } }),
    );
    await expect(history(fetch)).rejects.toMatchObject({ code: "invalid" });
  });

  it("reports a network failure and keeps the cause", async () => {
    const cause = new TypeError("fetch failed");
    const { fetch } = fakeFetch(() => cause);
    const err = await history(fetch).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "network" });
    expect((err as YahooError).cause).toBe(cause);
  });

  it("times out a request that never answers", async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () =>
          reject(init!.signal!.reason),
        );
      })) as unknown as typeof fetch;
    await expect(
      createYahooProvider({ fetch: impl, timeoutMs: 20 }).history(
        "AAA",
        "2024-03-01",
        "2024-03-02",
      ),
    ).rejects.toThrow(/in time/);
  });
});
