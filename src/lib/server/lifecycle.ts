import { closeDatabase, getDB } from "$lib/server/db";
import { drainDetached } from "$lib/server/detached";
import { describeError } from "$lib/server/errors";
import { closeJobLocks } from "$lib/server/scheduling";

/** How long shutdown waits for background work before closing the database anyway. */
export const DRAIN_TIMEOUT_MS = 10_000;

const jobs: { name: string; stop: () => void }[] = [];
let shuttingDown: Promise<void> | null = null;
let installed = false;

/** Registers a background job to stop first on shutdown, in registration order. */
export function onShutdown(name: string, stop: () => void): void {
  jobs.push({ name, stop });
}

async function attempt(what: string, step: () => void | Promise<void>) {
  try {
    await step();
  } catch (err) {
    console.error("shutdown: %s failed: %s", what, describeError(err));
  }
}

/**
 * Stops the schedulers, gives work that is already running up to
 * `drainTimeoutMs` to finish, then closes the job locks and the database.
 * Runs once; later calls return the same promise. Never rejects: each step's
 * failure is logged and the rest still run.
 */
export function shutdown(drainTimeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
  shuttingDown ??= (async () => {
    console.info("shutting down: stopping background jobs");
    for (const job of jobs) await attempt(`stopping ${job.name}`, job.stop);
    try {
      await drainDetached(drainTimeoutMs);
    } catch (err) {
      console.warn(
        "shutdown: background work still running after %dms, closing anyway (%s)",
        drainTimeoutMs,
        describeError(err),
      );
    }
    await attempt("closing job locks", closeJobLocks);
    await attempt("closing the database", () => closeDatabase(getDB()));
    console.info("shutdown complete");
  })();
  return shuttingDown;
}

/**
 * Runs `shutdown()` when the server is told to stop. svelte-adapter-bun owns
 * SIGTERM and SIGINT: it emits `sveltekit:shutdown` on `process` and then stops
 * the HTTP server, so this listens for that event instead of adding signal
 * handlers of its own. Call once from the init hook.
 */
export function installShutdownHandler(): void {
  if (installed) return;
  installed = true;
  process.once("sveltekit:shutdown", () => {
    void shutdown();
  });
}

/** Tests only. */
export function resetShutdownForTests(): void {
  shuttingDown = null;
  installed = false;
  jobs.length = 0;
  process.removeAllListeners("sveltekit:shutdown");
}
