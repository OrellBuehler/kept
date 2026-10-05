import { startTicker } from "$lib/server/scheduling";
import { runNotifications } from "./run";
import { readSmtpConfig, type SmtpConfig } from "./smtp";

export { readSmtpConfig };

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;

let smtp: SmtpConfig | null = null;
let stop: (() => void) | null = null;

/** The administrator's SMTP settings, or null when the email channel is not offered. */
export function getSmtpConfig(): SmtpConfig | null {
  return smtp;
}

/** Reads the SMTP env vars (invalid values throw) and starts the hourly evaluation. Called once from the init hook. */
export function registerNotifications(
  options: { intervalMs?: number; firstRunDelayMs?: number } = {},
): void {
  if (stop) return;
  smtp = readSmtpConfig();
  const stopTicker = startTicker({
    name: "notifications",
    intervalMs: options.intervalMs ?? CHECK_INTERVAL_MS,
    firstRunDelayMs: options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS,
    run: () => runNotifications({ smtp }),
  });
  stop = () => {
    stopTicker();
    stop = null;
  };
}

/** Tests only. */
export function unregisterNotifications(): void {
  stop?.();
  smtp = null;
}
