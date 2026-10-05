import { startTicker } from "$lib/server/scheduling";
import { refreshPrices, listMarketDataUserIds } from "$lib/server/investments";
import { localToday } from "$lib/server/ledger/balances";
import { errorCode } from "$lib/server/errors";

export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const JITTER_MS = 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One pass over every user who opted in. Request failures are stored on the
 * user's settings by `refreshPrices`; only counts and codes are logged here.
 */
export async function runRefresh(
  options: { jitterMs?: number } = {},
): Promise<void> {
  const jitter = options.jitterMs ?? 0;
  for (const userId of await listMarketDataUserIds()) {
    try {
      if (jitter > 0) await sleep(Math.random() * jitter);
      const result = await refreshPrices(userId, localToday());
      if (result.errors.length > 0) {
        console.warn(
          "market data: refresh finished with failed requests",
          result.errors.length,
        );
      }
    } catch (err) {
      console.error("market data: refresh failed", errorCode(err));
    }
  }
}

/** Starts the periodic refresh; returns a function that stops it. */
export function startScheduler(
  options: {
    intervalMs?: number;
    firstRunDelayMs?: number;
    jitterMs?: number;
  } = {},
): () => void {
  return startTicker({
    name: "market data refresh",
    intervalMs: options.intervalMs ?? REFRESH_INTERVAL_MS,
    firstRunDelayMs: options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS,
    run: () => runRefresh({ jitterMs: options.jitterMs ?? JITTER_MS }),
  });
}
