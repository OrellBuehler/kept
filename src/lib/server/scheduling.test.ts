import { afterEach, describe, expect, it, vi } from "vitest";
import { drainDetached } from "$lib/server/detached";
import { dialect } from "$lib/server/db/dialect";
import { useTestDB } from "$lib/testing/db";
import { closeJobLocks, runExclusive, startTicker } from "./scheduling";

useTestDB();
afterEach(async () => {
  vi.restoreAllMocks();
  await closeJobLocks();
});

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

describe("runExclusive", () => {
  it("runs the job and reports it", async () => {
    const fn = vi.fn(async () => undefined);
    expect(await runExclusive("job-a", fn)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("propagates the job's error and runs again afterwards", async () => {
    await expect(
      runExclusive("job-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const fn = vi.fn(async () => undefined);
    expect(await runExclusive("job-a", fn)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it.skipIf(dialect !== "pg")(
    "skips a job another holder is running, but not other jobs",
    async () => {
      const held = gate();
      const started = gate();
      const first = runExclusive("job-a", async () => {
        started.open();
        await held.promise;
      });
      await started.promise;
      const skipped = vi.fn(async () => undefined);
      const other = vi.fn(async () => undefined);
      expect(await runExclusive("job-a", skipped)).toBe(false);
      expect(await runExclusive("job-b", other)).toBe(true);
      expect(skipped).not.toHaveBeenCalled();
      held.open();
      expect(await first).toBe(true);
      expect(await runExclusive("job-a", skipped)).toBe(true);
    },
  );
});

describe("startTicker", () => {
  it("runs after the first delay, then on every interval, until stopped", async () => {
    const run = vi.fn(async () => undefined);
    const stop = startTicker({
      name: "t",
      intervalMs: 30,
      firstRunDelayMs: 5,
      run,
    });
    await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThan(1));
    stop();
    await drainDetached();
    const before = run.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run).toHaveBeenCalledTimes(before);
  });

  it("does not overlap a tick that is still running", async () => {
    const held = gate();
    const run = vi.fn(() => held.promise);
    const stop = startTicker({
      name: "t",
      intervalMs: 10,
      firstRunDelayMs: 5,
      run,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run).toHaveBeenCalledTimes(1);
    held.open();
    stop();
    await drainDetached();
  });

  it("logs a failing tick by name and keeps ticking", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const stop = startTicker({
      name: "sample job",
      intervalMs: 20,
      firstRunDelayMs: 5,
      run,
    });
    await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThan(1));
    stop();
    await drainDetached();
    expect(error).toHaveBeenCalledWith(
      "%s tick failed: %s",
      "sample job",
      expect.any(String),
    );
  });
});
