import { startTicker } from "$lib/server/scheduling";
import { readInboxConfig, scanInbox, setLastScan } from "./inbox";

export * from "./inbox";

let stop: (() => void) | null = null;

/**
 * Starts the watch-folder import when `KEPT_INBOX_DIR` is set. Called once from
 * the init hook. With several instances on one PostgreSQL only one scans at a
 * time, so the folder has to be shared by all of them.
 */
export function registerInbox(): void {
  if (stop) return;
  const config = readInboxConfig();
  if (!config) return;
  const stopTicker = startTicker({
    name: "inbox scan",
    intervalMs: config.intervalSeconds * 1000,
    firstRunDelayMs: 5_000,
    run: async () => setLastScan(await scanInbox(config)),
  });
  stop = () => {
    stopTicker();
    stop = null;
  };
}

/** Stops the watch-folder scan (shutdown, tests). A scan already running finishes. */
export function stopInbox(): void {
  stop?.();
}
