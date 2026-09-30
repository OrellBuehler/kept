import { errorCode } from "./client";
import { listEnabledConnections } from "./connection";
import { pushAllLinked } from "./push";
import { resolvePendingUploads } from "./reports";
import { isSyncing, syncConnection } from "./sync";

export const CATCH_UP_INTERVAL_MS = 30 * 60 * 1000;
const JITTER_MS = 60_000;
const FIRST_RUN_DELAY_MS = 60_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One catch-up pass over every enabled connection: new and changed documents,
 * report uploads still processing, bills whose values drifted from Paperless.
 * A connection that is already syncing is skipped.
 */
export async function runCatchUp(
  options: { jitterMs?: number } = {},
): Promise<void> {
  const jitter = options.jitterMs ?? 0;
  for (const row of listEnabledConnections()) {
    if (isSyncing(row.id)) continue;
    try {
      if (jitter > 0) await sleep(Math.random() * jitter);
      const result = await syncConnection(row.userId);
      if (result.error === null) {
        await resolvePendingUploads(row.userId);
        await pushAllLinked(row.userId);
      }
    } catch (err) {
      console.error("paperless catch-up failed", errorCode(err));
    }
  }
}

/** Starts the periodic catch-up; returns a function that stops it. */
export function startScheduler(
  options: {
    intervalMs?: number;
    firstRunDelayMs?: number;
    jitterMs?: number;
  } = {},
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runCatchUp({ jitterMs: options.jitterMs ?? JITTER_MS });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(
    () => void tick(),
    options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS,
  );
  const timer = setInterval(
    () => void tick(),
    options.intervalMs ?? CATCH_UP_INTERVAL_MS,
  );
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
