import { readInboxConfig, startInboxScheduler } from "./inbox";

export * from "./inbox";

let stop: (() => void) | null = null;

/** Starts the watch-folder import when `KEPT_INBOX_DIR` is set. Called once from the init hook. */
export function registerInbox(): void {
  if (stop) return;
  const config = readInboxConfig();
  if (!config) return;
  const stopScheduler = startInboxScheduler(config);
  stop = () => {
    stopScheduler();
    stop = null;
  };
}
