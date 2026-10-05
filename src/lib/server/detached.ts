/**
 * Registry of fire-and-forget work (bill-changed listeners, scheduler ticks,
 * webhook jobs). Nothing waits for it while serving; shutdown drains it before
 * closing the database, and tests drain it between cases so that work started
 * by one test cannot write into the next test's database.
 */
import { describeError } from "$lib/server/errors";

const inFlight = new Set<Promise<void>>();

/**
 * Starts tracking `work`. A rejection is logged by code only and never
 * propagates: the work is detached, so nobody is left to handle it.
 */
export function detach(work: Promise<unknown>): void {
  const tracked: Promise<void> = work.then(
    () => undefined,
    (err: unknown) => {
      console.error("detached task failed", describeError(err));
    },
  );
  inFlight.add(tracked);
  void tracked.finally(() => inFlight.delete(tracked));
}

/**
 * Used by shutdown and by tests. Resolves once every detached task, including those the drained
 * ones start, has settled; throws if that takes longer than `timeoutMs`.
 */
export async function drainDetached(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0) {
    const left = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(left, 0));
    });
    const outcome = await Promise.race([
      Promise.all([...inFlight]).then(() => "settled" as const),
      expired,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      throw new Error(
        `${inFlight.size} detached task(s) still running after ${timeoutMs}ms`,
      );
    }
  }
}
