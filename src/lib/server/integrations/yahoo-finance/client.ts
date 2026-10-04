import { z } from "zod";
import type { SecurityKind } from "$lib/investment-types";
import { fixedFromProviderNumber, type Fixed8 } from "$lib/quantity";
import {
  QuoteProviderError,
  type FxPoint,
  type QuoteProvider,
  type QuotePoint,
  type SecurityMatch,
} from "$lib/server/investments";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const DEFAULT_TIMEOUT_MS = 15_000;
const SIGNIFICANT_DIGITS = 7;
const DAY_SECONDS = 86_400;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Quoted in a minor unit (pence, cents): the major-unit currency and the divisor. */
const MINOR_UNIT_CURRENCIES: Record<string, string> = {
  GBp: "GBP",
  GBX: "GBP",
  ZAc: "ZAR",
  ILA: "ILS",
};

const KINDS: Record<string, SecurityKind> = {
  ETF: "etf",
  EQUITY: "stock",
  MUTUALFUND: "fund",
};

export class YahooError extends QuoteProviderError {
  constructor(
    readonly code: "http" | "rate_limited" | "no_data" | "invalid" | "network",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "YahooError";
  }
}

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            currency: z.string().optional(),
            exchangeTimezoneName: z.string().optional(),
            gmtoffset: z.number().optional(),
          }),
          timestamp: z.array(z.number()).optional(),
          indicators: z
            .object({
              quote: z
                .array(z.object({ close: z.array(z.number().nullable()) }))
                .optional(),
            })
            .optional(),
        }),
      )
      .nullish(),
    error: z.object({ description: z.string().nullish() }).nullish(),
  }),
});

const errorBodySchema = z.object({
  chart: z.object({
    error: z.object({ description: z.string() }),
  }),
});

const searchSchema = z.object({
  quotes: z
    .array(
      z.object({
        symbol: z.string().optional(),
        shortname: z.string().optional(),
        longname: z.string().optional(),
        quoteType: z.string().optional(),
        isin: z.string().optional(),
      }),
    )
    .default([]),
});

export interface YahooOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const CURRENCY = /^[A-Za-z]{3}$/;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Unix seconds for the start of `date` (UTC), shifted by whole days. */
function unixAt(date: string, shiftDays: number): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000 + shiftDays * DAY_SECONDS;
}

/**
 * Maps a Unix timestamp to the exchange-local calendar day. The named zone is
 * preferred because it follows daylight saving; `gmtoffset` is the fallback.
 */
function localDateOf(
  timestamp: number,
  meta: { exchangeTimezoneName?: string; gmtoffset?: number },
  formatter: Intl.DateTimeFormat | null,
): string {
  if (formatter) {
    const parts = formatter.formatToParts(new Date(timestamp * 1000));
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  return isoDate((timestamp + (meta.gmtoffset ?? 0)) * 1000);
}

function zoneFormatter(name: string | undefined): Intl.DateTimeFormat | null {
  if (!name) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch (err) {
    if (err instanceof RangeError) return null; // unknown zone: use gmtoffset
    throw err;
  }
}

/**
 * Closes arrive as float32-ish values (773.38000488). Seven significant digits
 * is what float32 carries, so rounding there recovers the quoted price.
 */
function roundSignificant(n: number): number {
  return Number(n.toPrecision(SIGNIFICANT_DIGITS));
}

/** Divides a fixed-point price by 100, rounding half up (prices are positive). */
function centsToUnits(value: Fixed8): Fixed8 {
  return Number((BigInt(value) + 50n) / 100n) as Fixed8;
}

export function createYahooProvider(options: YahooOptions = {}): QuoteProvider {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function getJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new YahooError(
        "network",
        timedOut
          ? "Yahoo Finance did not answer in time."
          : "Could not reach Yahoo Finance.",
        { cause: err },
      );
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (err) {
      if (response.ok) {
        throw new YahooError(
          "invalid",
          "Yahoo Finance sent an unreadable response.",
          {
            cause: err,
          },
        );
      }
    }
    if (response.status === 429) {
      throw new YahooError(
        "rate_limited",
        "Yahoo Finance is limiting requests. Try again later.",
      );
    }
    if (!response.ok) {
      const detail = errorBodySchema.safeParse(body);
      throw new YahooError(
        "http",
        detail.success
          ? `Yahoo Finance: ${detail.data.chart.error.description}`
          : `Yahoo Finance answered with HTTP ${response.status}.`,
      );
    }
    return body;
  }

  async function chart(
    symbol: string,
    from: string,
    to: string,
  ): Promise<{ currency: string | null; points: QuotePoint[] }> {
    // A day of margin on each side so the exchange-local day is never cut off.
    const query = new URLSearchParams({
      period1: String(unixAt(from, -1)),
      period2: String(unixAt(to, 2)),
      interval: "1d",
    });
    const url = `${CHART_URL}/${encodeURIComponent(symbol)}?${query}`;
    const parsed = chartSchema.safeParse(await getJson(url));
    if (!parsed.success) {
      throw new YahooError(
        "invalid",
        "Yahoo Finance sent an unexpected response.",
        {
          cause: parsed.error,
        },
      );
    }
    const { result, error } = parsed.data.chart;
    if (error) {
      throw new YahooError(
        "no_data",
        `Yahoo Finance: ${error.description ?? "no data"}`,
      );
    }
    const series = result?.[0];
    if (!series) throw new YahooError("no_data", "Yahoo Finance has no data.");

    const closes = series.indicators?.quote?.[0]?.close ?? [];
    const formatter = zoneFormatter(series.meta.exchangeTimezoneName);
    // The last bar can repeat the previous day while the market is open; the later one wins.
    const byDate = new Map<string, Fixed8>();
    (series.timestamp ?? []).forEach((timestamp, i) => {
      const close = closes[i];
      if (close === null || close === undefined || !(close > 0)) return;
      const date = localDateOf(timestamp, series.meta, formatter);
      if (date < from || date > to) return;
      byDate.set(date, fixedFromProviderNumber(roundSignificant(close)));
    });
    const points = [...byDate]
      .map(([date, price]) => ({ date, price }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { currency: series.meta.currency ?? null, points };
  }

  return {
    async history(symbol, from, to) {
      const { currency, points } = await chart(symbol, from, to);
      if (!currency) {
        throw new YahooError(
          "invalid",
          "Yahoo Finance did not name a currency.",
        );
      }
      const major = MINOR_UNIT_CURRENCIES[currency];
      if (!major) return { currency: currency.toUpperCase(), points };
      return {
        currency: major,
        points: points.map((p) => ({
          date: p.date,
          price: centsToUnits(p.price),
        })),
      };
    },

    async fx(base, quote, from, to): Promise<FxPoint[]> {
      if (!CURRENCY.test(base) || !CURRENCY.test(quote)) {
        throw new YahooError("invalid", "Not a currency code.");
      }
      const { currency, points } = await chart(
        `${base.toUpperCase()}${quote.toUpperCase()}=X`,
        from,
        to,
      );
      if (currency && currency.toUpperCase() !== quote.toUpperCase()) {
        throw new YahooError(
          "invalid",
          "Yahoo Finance quoted the pair in a different currency.",
        );
      }
      return points.map((p) => ({ date: p.date, rate: p.price }));
    },

    async search(query): Promise<SecurityMatch[]> {
      const params = new URLSearchParams({
        q: query,
        quotesCount: "10",
        newsCount: "0",
      });
      const parsed = searchSchema.safeParse(
        await getJson(`${SEARCH_URL}?${params}`),
      );
      if (!parsed.success) {
        throw new YahooError(
          "invalid",
          "Yahoo Finance sent an unexpected response.",
          { cause: parsed.error },
        );
      }
      return parsed.data.quotes.flatMap((q) =>
        q.symbol
          ? [
              {
                symbol: q.symbol,
                name: q.longname ?? q.shortname ?? q.symbol,
                currency: null,
                kind: (q.quoteType && KINDS[q.quoteType]) || null,
                isin: q.isin ?? null,
              },
            ]
          : [],
      );
    },
  };
}
