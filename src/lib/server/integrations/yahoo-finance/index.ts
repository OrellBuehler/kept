import { setQuoteProvider } from "$lib/server/investments";
import { createYahooProvider } from "./client";
import { startScheduler } from "./scheduler";

let stop: (() => void) | null = null;

/**
 * Wires the adapter into the app: registers the quote provider and starts the
 * periodic price refresh. Nothing is fetched for users who have not opted in.
 * Called once from the server's init hook.
 */
export function registerMarketData(): void {
  if (stop) return;
  setQuoteProvider(createYahooProvider());
  const stopScheduler = startScheduler();
  stop = () => {
    stopScheduler();
    setQuoteProvider(null);
    stop = null;
  };
}

/** Tests only. */
export function unregisterMarketData(): void {
  stop?.();
}
