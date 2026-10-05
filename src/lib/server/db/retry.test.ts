import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerError } from "$lib/server/ledger/errors";
import { useTestDB } from "$lib/testing/db";
import {
  afterCommit,
  getDB,
  isRetryableConflict,
  transaction,
  users,
} from "./index";

useTestDB();

afterEach(() => vi.restoreAllMocks());

/** What Bun's driver throws for a deadlock or a serialization failure. */
const pgError = (state: string) =>
  Object.assign(new Error("aborted"), { errno: state });

const insertUser = (username: string) =>
  getDB().insert(users).values({ username, passwordHash: "x" });
const names = async () =>
  (await getDB().select({ u: users.username }).from(users)).map((r) => r.u);

describe("isRetryableConflict", () => {
  it("recognises both states, also in a cause chain", () => {
    expect(isRetryableConflict(pgError("40P01"))).toBe(true);
    expect(isRetryableConflict(pgError("40001"))).toBe(true);
    expect(
      isRetryableConflict(new Error("wrapped", { cause: pgError("40P01") })),
    ).toBe(true);
    expect(isRetryableConflict(pgError("23505"))).toBe(false);
    expect(isRetryableConflict(new Error("plain"))).toBe(false);
    expect(isRetryableConflict(null)).toBe(false);
  });
});

describe("transaction retry", () => {
  it("runs the callback again after a deadlock and commits that attempt only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const hook = vi.fn();
    const result = await transaction(async () => {
      attempts++;
      await insertUser(`try${attempts}`);
      afterCommit(hook);
      if (attempts === 1) throw pgError("40P01");
      return "done";
    });
    expect(result).toBe("done");
    expect(attempts).toBe(2);
    expect(await names()).toEqual(["try2"]);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("retries a serialization failure too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await transaction(async () => {
      if (++attempts < 3) throw pgError("40001");
    });
    expect(attempts).toBe(3);
  });

  it("gives up after three attempts with the changed-meanwhile conflict", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const hook = vi.fn();
    const error = await transaction(async () => {
      attempts++;
      await insertUser("never");
      afterCommit(hook);
      throw pgError("40P01");
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(attempts).toBe(3);
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe("conflict");
    expect(hook).not.toHaveBeenCalled();
    expect(await names()).toEqual([]);
    expect(log.mock.calls.flat().join(" ")).not.toContain("never");
  });

  it("does not retry other errors", async () => {
    let attempts = 0;
    await expect(
      transaction(async () => {
        attempts++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });

  it("restarts only the outermost transaction, never a nested one on its own", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let outer = 0;
    let inner = 0;
    await transaction(async () => {
      outer++;
      await transaction(async () => {
        inner++;
        if (outer === 1) throw pgError("40P01");
      });
    });
    expect(outer).toBe(2);
    expect(inner).toBe(2);
  });
});
