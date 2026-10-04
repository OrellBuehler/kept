import { and, eq, min, max } from "drizzle-orm";
import type { SecurityKind } from "$lib/investment-types";
import type { Fixed8 } from "$lib/quantity";
import {
  accounts,
  fxRates,
  getDB,
  marketDataSettings,
  securities,
  securityPrices,
  trades,
} from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { isRealDate } from "$lib/server/ledger/schemas";
import { upsertFxRates, upsertProviderPrices } from "./prices";

export interface QuotePoint {
  date: string;
  price: Fixed8;
}

export interface FxPoint {
  date: string;
  rate: Fixed8;
}

export interface SecurityMatch {
  symbol: string;
  name: string;
  currency: string | null;
  kind: SecurityKind | null;
  isin: string | null;
}

/**
 * A source of daily closing prices. Implementations live under
 * `integrations/`; the core only knows this interface. Dates are YYYY-MM-DD,
 * `from` and `to` inclusive.
 */
export interface QuoteProvider {
  /** `currency` is the one `points` are quoted in, after any minor-unit normalisation. */
  history(
    symbol: string,
    from: string,
    to: string,
  ): Promise<{ currency: string; points: QuotePoint[] }>;
  /** Units of `quote` per one unit of `base`. */
  fx(base: string, quote: string, from: string, to: string): Promise<FxPoint[]>;
  search(query: string): Promise<SecurityMatch[]>;
}

/**
 * A failure of a quote provider whose message is written for the user (no
 * secrets, no request data). Anything else a provider throws is unexpected and
 * is shown as a generic error.
 */
export class QuoteProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QuoteProviderError";
  }
}

let provider: QuoteProvider | null = null;

/** Registers the quote provider; pass null to unregister (tests). */
export function setQuoteProvider(next: QuoteProvider | null): void {
  provider = next;
}

export function getQuoteProvider(): QuoteProvider | null {
  return provider;
}

// --- settings -------------------------------------------------------------

export interface MarketDataSettingsView {
  enabled: boolean;
  lastRunAt: number | null;
  lastError: string | null;
}

export function getMarketDataSettings(userId: string): MarketDataSettingsView {
  const row = getDB()
    .select({
      enabled: marketDataSettings.enabled,
      lastRunAt: marketDataSettings.lastRunAt,
      lastError: marketDataSettings.lastError,
    })
    .from(marketDataSettings)
    .where(eq(marketDataSettings.userId, userId))
    .get();
  if (!row) return { enabled: false, lastRunAt: null, lastError: null };
  return {
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.getTime() ?? null,
    lastError: row.lastError,
  };
}

export function setMarketDataEnabled(
  userId: string,
  enabled: boolean,
): MarketDataSettingsView {
  getDB()
    .insert(marketDataSettings)
    .values({ userId, enabled })
    .onConflictDoUpdate({
      target: marketDataSettings.userId,
      set: { enabled, updatedAt: new Date() },
    })
    .run();
  return getMarketDataSettings(userId);
}

/** Users who opted in to market data; for the scheduler. */
export function listMarketDataUserIds(): string[] {
  return getDB()
    .select({ userId: marketDataSettings.userId })
    .from(marketDataSettings)
    .where(eq(marketDataSettings.enabled, true))
    .all()
    .map((r) => r.userId);
}

function recordRun(userId: string, now: Date, lastError: string | null) {
  getDB()
    .insert(marketDataSettings)
    .values({ userId, lastRunAt: now, lastError })
    .onConflictDoUpdate({
      target: marketDataSettings.userId,
      set: { lastRunAt: now, lastError, updatedAt: new Date() },
    })
    .run();
}

// --- refresh --------------------------------------------------------------

export interface RefreshResult {
  securities: number;
  fxPairs: number;
  prices: number;
  fxRates: number;
  /** One entry per failed request; also stored as the settings' last error. */
  errors: string[];
}

const MAX_ERROR_LENGTH = 500;
/** Fetched history that starts later than this after the first trade is refetched from the first trade. */
const BACKFILL_GAP_DAYS = 7;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * Where a fetch starts: the first trade, or, when history already exists, its
 * last date (inclusive, so the most recent close is refreshed), unless that
 * history starts well after the first trade.
 */
function fetchFrom(
  firstTrade: string,
  have: { first: string; last: string } | undefined,
): string {
  if (!have || have.first > addDays(firstTrade, BACKFILL_GAP_DAYS)) {
    return firstTrade;
  }
  return have.last > firstTrade ? have.last : firstTrade;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function assertPointDates(points: readonly { date: string }[]) {
  if (points.some((p) => !isRealDate(p.date))) {
    throw new Error("The provider returned an invalid date.");
  }
}

/**
 * Fetches daily prices for every security with a symbol and every
 * security-to-account currency pair in use, from the first trade (or the last
 * fetched day) up to `today`. Only symbols and currency pairs go to the
 * provider. Failures of single requests do not stop the run; they are
 * collected in `errors` and in the settings' `lastError`.
 */
export async function refreshPrices(
  userId: string,
  today: string,
  now: Date = new Date(),
): Promise<RefreshResult> {
  if (!getMarketDataSettings(userId).enabled) {
    throw new LedgerError("conflict", "Market data is turned off.");
  }
  const source = provider;
  if (!source) {
    throw new LedgerError("invalid", "No market data provider is available.");
  }
  const db = getDB();

  const uses = db
    .select({
      securityId: securities.id,
      symbol: securities.symbol,
      currency: securities.currency,
      accountCurrency: accounts.currency,
      first: min(trades.date),
    })
    .from(trades)
    .innerJoin(securities, eq(securities.id, trades.securityId))
    .innerJoin(accounts, eq(accounts.id, trades.accountId))
    .where(eq(trades.userId, userId))
    .groupBy(
      securities.id,
      securities.symbol,
      securities.currency,
      accounts.currency,
    )
    .all();

  const priceSpan = new Map(
    db
      .select({
        securityId: securityPrices.securityId,
        first: min(securityPrices.date),
        last: max(securityPrices.date),
      })
      .from(securityPrices)
      .where(
        and(
          eq(securityPrices.userId, userId),
          eq(securityPrices.source, "provider"),
        ),
      )
      .groupBy(securityPrices.securityId)
      .all()
      .map((r) => [r.securityId, { first: r.first!, last: r.last! }]),
  );
  const fxSpan = new Map(
    db
      .select({
        base: fxRates.base,
        quote: fxRates.quote,
        first: min(fxRates.date),
        last: max(fxRates.date),
      })
      .from(fxRates)
      .where(and(eq(fxRates.userId, userId), eq(fxRates.source, "provider")))
      .groupBy(fxRates.base, fxRates.quote)
      .all()
      .map((r) => [`${r.base}/${r.quote}`, { first: r.first!, last: r.last! }]),
  );

  const symbols = new Map<
    string,
    { symbol: string; currency: string; firstTrade: string }
  >();
  const pairs = new Map<
    string,
    { base: string; quote: string; firstTrade: string }
  >();
  for (const u of uses) {
    const firstTrade = u.first!;
    if (u.symbol !== null) {
      const existing = symbols.get(u.securityId);
      if (!existing || firstTrade < existing.firstTrade) {
        symbols.set(u.securityId, {
          symbol: u.symbol,
          currency: u.currency,
          firstTrade,
        });
      }
    }
    if (u.currency !== u.accountCurrency) {
      const key = `${u.currency}/${u.accountCurrency}`;
      const existing = pairs.get(key);
      if (!existing || firstTrade < existing.firstTrade) {
        pairs.set(key, {
          base: u.currency,
          quote: u.accountCurrency,
          firstTrade,
        });
      }
    }
  }

  const result: RefreshResult = {
    securities: 0,
    fxPairs: 0,
    prices: 0,
    fxRates: 0,
    errors: [],
  };

  for (const [securityId, target] of symbols) {
    const from = fetchFrom(target.firstTrade, priceSpan.get(securityId));
    if (from > today) continue;
    try {
      const history = await source.history(target.symbol, from, today);
      if (history.currency.toUpperCase() !== target.currency) {
        throw new Error(
          `quoted in ${history.currency}, expected ${target.currency}`,
        );
      }
      assertPointDates(history.points);
      const points = history.points.filter(
        (p) => p.date >= from && p.date <= today,
      );
      result.prices += upsertProviderPrices(userId, securityId, points);
      result.securities += 1;
    } catch (err) {
      result.errors.push(`${target.symbol}: ${describe(err)}`);
    }
  }

  for (const [key, pair] of pairs) {
    const from = fetchFrom(pair.firstTrade, fxSpan.get(key));
    if (from > today) continue;
    try {
      const points = await source.fx(pair.base, pair.quote, from, today);
      assertPointDates(points);
      result.fxRates += upsertFxRates(
        userId,
        points
          .filter((p) => p.date >= from && p.date <= today && p.rate > 0)
          .map((p) => ({ base: pair.base, quote: pair.quote, ...p })),
      );
      result.fxPairs += 1;
    } catch (err) {
      result.errors.push(`${key}: ${describe(err)}`);
    }
  }

  recordRun(
    userId,
    now,
    result.errors.length > 0
      ? result.errors.join("; ").slice(0, MAX_ERROR_LENGTH)
      : null,
  );
  return result;
}
