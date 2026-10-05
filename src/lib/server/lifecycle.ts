import { closeDatabase, getDB } from "$lib/server/db";
import { drainDetached } from "$lib/server/detached";
import { describeError } from "$lib/server/errors";
import { closeJobLocks } from "$lib/server/scheduling";

/** How long shutdown waits for background work before closing the database anyway. */
export const DRAIN_TIMEOUT_MS = 10_000;

const jobs: { name: string; stop: () => void }[] = [];
let shuttingDown: Promise<void> | null = null;
let installed = false;
let inFlight = 0;
const idleWaiters: (() => void)[] = [];

/**
 * Runs one request's handler, counting it so shutdown can wait for it. The
 * adapter stops the HTTP server right after announcing the shutdown, without
 * waiting for us, so requests still mid-handler are what shutdown must outlast.
 * Only the handler is counted, not a response body that is still streaming.
 */
export async function trackRequest<T>(work: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    if (inFlight === 0) for (const wake of idleWaiters.splice(0)) wake();
  }
}

/** Resolves true once no request is in flight, false after `timeoutMs`. */
function requestsIdle(timeoutMs: number): Promise<boolean> {
  if (inFlight === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        const at = idleWaiters.indexOf(wake);
        if (at >= 0) idleWaiters.splice(at, 1);
        resolve(false);
      },
      Math.max(timeoutMs, 0),
    );
    const wake = () => {
      clearTimeout(timer);
      resolve(true);
    };
    idleWaiters.push(wake);
  });
}

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
 * Stops the schedulers, gives requests and background work that are already
 * running up to
 * `drainTimeoutMs` to finish, then closes the job locks and the database.
 * Runs once; later calls return the same promise. Never rejects: each step's
 * failure is logged and the rest still run.
 */
export function shutdown(drainTimeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
  shuttingDown ??= (async () => {
    console.info("shutting down: stopping background jobs");
    for (const job of jobs) await attempt(`stopping ${job.name}`, job.stop);
    const deadline = Date.now() + drainTimeoutMs;
    if (!(await requestsIdle(drainTimeoutMs))) {
      console.warn(
        "shutdown: %d request(s) still running after %dms, closing anyway",
        inFlight,
        drainTimeoutMs,
      );
    }
    try {
      await drainDetached(Math.max(deadline - Date.now(), 0));
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
  inFlight = 0;
  idleWaiters.length = 0;
  process.removeAllListeners("sveltekit:shutdown");
}
