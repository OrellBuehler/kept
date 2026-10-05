import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const drain = vi.fn<(ms?: number) => Promise<void>>();
const stepFails = { inbox: false };

vi.mock("$lib/server/scheduling", () => ({
  closeJobLocks: async () => void calls.push("locks"),
}));
vi.mock("$lib/server/detached", () => ({
  drainDetached: async (ms?: number) => {
    calls.push("drain");
    await drain(ms);
  },
}));
vi.mock("$lib/server/db", () => ({
  getDB: () => ({}),
  closeDatabase: async () => void calls.push("close"),
}));

import {
  installShutdownHandler,
  onShutdown,
  resetShutdownForTests,
  shutdown,
  trackRequest,
} from "./lifecycle";

beforeEach(() => {
  calls.length = 0;
  stepFails.inbox = false;
  drain.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetShutdownForTests();
  onShutdown("backups", () => calls.push("backups"));
  onShutdown("inbox", () => {
    calls.push("inbox");
    if (stepFails.inbox) throw new Error("inbox stop failed");
  });
  onShutdown("notifications", () => calls.push("notifications"));
});
afterEach(() => {
  vi.restoreAllMocks();
  resetShutdownForTests();
});

describe("shutdown", () => {
  it("stops every job, drains, then closes locks and the database, in that order", async () => {
    await shutdown();
    expect(calls).toEqual([
      "backups",
      "inbox",
      "notifications",
      "drain",
      "locks",
      "close",
    ]);
  });

  it("passes the bound to the drain", async () => {
    await shutdown(1234);
    expect(drain).toHaveBeenCalledWith(1234);
  });

  it("closes the database even when work does not finish in time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    drain.mockRejectedValue(new Error("1 detached task(s) still running"));
    await shutdown(5);
    expect(warn).toHaveBeenCalled();
    expect(calls.slice(-2)).toEqual(["locks", "close"]);
  });

  it("a failing step is logged and does not stop the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stepFails.inbox = true;
    await shutdown();
    expect(error).toHaveBeenCalled();
    expect(calls).toContain("close");
    expect(calls).toContain("notifications");
  });

  it("runs once however often it is called", async () => {
    await Promise.all([shutdown(), shutdown()]);
    await shutdown();
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });
});

describe("installShutdownHandler", () => {
  it("shuts down when the adapter announces the shutdown", async () => {
    installShutdownHandler();
    installShutdownHandler();
    expect(process.listenerCount("sveltekit:shutdown")).toBe(1);
    (process as NodeJS.EventEmitter).emit("sveltekit:shutdown", "SIGTERM");
    await shutdown();
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });
});

describe("request tracking", () => {
  it("waits for a request that is mid-handler before closing the database", async () => {
    let finish!: () => void;
    const request = trackRequest(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const done = shutdown(5000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).not.toContain("close");
    finish();
    await request;
    await done;
    expect(calls.slice(-3)).toEqual(["drain", "locks", "close"]);
  });

  it("closes anyway once the bound passes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stuck = new Promise<void>(() => {});
    void trackRequest(() => stuck);
    await shutdown(20);
    expect(warn).toHaveBeenCalled();
    expect(calls).toContain("close");
  });

  it("returns the handler's result and counts a failing handler as finished", async () => {
    expect(await trackRequest(async () => 7)).toBe(7);
    await expect(
      trackRequest(async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    await shutdown(5000);
    expect(calls).toContain("close");
  });
});
