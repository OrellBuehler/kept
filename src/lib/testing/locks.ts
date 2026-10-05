import { expect } from "vitest";
import { transaction } from "$lib/server/db";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Asserts that `operation` takes the transaction lock `key`: while another
 * transaction holds it, the operation must not finish; once released it does.
 *
 * Only meaningful on PostgreSQL (the `pg` project, run in CI). There the lock
 * is an advisory lock and a missing or misspelled key lets the operation
 * finish and fail the test. On SQLite the lock itself is a no-op and the held
 * transaction blocks every other one, so the check passes whatever key the
 * operation takes; a green SQLite run proves nothing about the lock.
 *
 * The wait is a negative check: a missing lock lets the operation finish within
 * milliseconds and fail the test, while a stalled machine can only make it pass.
 */
export async function expectHeldBy(
  key: string,
  operation: () => Promise<unknown>,
  waitMs = 250,
): Promise<void> {
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const holder = transaction(
    async () => {
      entered();
      await hold;
    },
    { lock: key },
  );
  await inside;
  let finished = false;
  const running = operation().then(
    () => {
      finished = true;
    },
    (error: unknown) => {
      finished = true;
      throw error;
    },
  );
  // Settle the operation's promise either way so a failure is not unhandled.
  running.catch(() => undefined);
  try {
    await sleep(waitMs);
    expect(finished, `the operation did not wait for the lock "${key}"`).toBe(
      false,
    );
  } finally {
    release();
    await holder;
  }
  await running;
}
