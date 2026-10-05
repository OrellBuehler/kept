import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  afterCommit,
  closeDatabase,
  getDB,
  migrateDatabase,
  openDatabase,
  setDB,
  transaction,
  users,
  withExclusiveClient,
  type DB,
} from "./index";

let root: DB;

function open(options: Parameters<typeof openDatabase>[1] = {}) {
  root = openDatabase(":memory:", { gateTimeoutMs: 1000, ...options });
  migrateDatabase(root);
  setDB(root);
}

beforeEach(() => open());

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase(root);
  setDB(null);
});

const insertUser = (db: DB, username: string) =>
  db.insert(users).values({ username, passwordHash: "x" });

const names = async () =>
  (
    await root.select({ u: users.username }).from(users).orderBy(users.username)
  ).map((r) => r.u);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The innermost cause: the driver's own message, not drizzle's wrapper. */
function rootMessage(err: unknown): string {
  let cursor = err as { message?: string; cause?: unknown };
  while (cursor.cause) cursor = cursor.cause as typeof cursor;
  return String(cursor.message);
}

describe("work that outlives a rolled-back transaction", () => {
  it("fails a sibling write that arrives after the rollback and persists nothing", async () => {
    let sibling!: Promise<unknown>;
    await expect(
      transaction(async () => {
        const failsFast = (async () => {
          await insertUser(getDB(), "early");
          throw new Error("fails fast");
        })();
        sibling = (async () => {
          await sleep(20);
          await insertUser(getDB(), "late");
        })();
        await Promise.all([failsFast, sibling]);
      }),
    ).rejects.toThrow("fails fast");
    await expect(sibling).rejects.toThrow(/rolled back/);
    await sleep(20);
    expect(await names()).toEqual([]);
  });

  it("refuses to start a transaction from work that outlives a rollback", async () => {
    let late!: Promise<unknown>;
    await expect(
      transaction(async () => {
        late = (async () => {
          await sleep(20);
          await transaction(async (tx) => {
            await insertUser(tx, "late");
          });
        })();
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await expect(late).rejects.toThrow(/rolled back/);
    expect(await names()).toEqual([]);
  });

  it("drops an afterCommit hook queued by work that outlives a rollback", async () => {
    const ran = vi.fn();
    await expect(
      transaction(async () => {
        setTimeout(() => afterCommit(ran), 10);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await sleep(30);
    expect(ran).not.toHaveBeenCalled();
  });

  it("still lets detached work fall back to the shared connection after a commit", async () => {
    let late!: Promise<unknown>;
    await transaction(async () => {
      late = (async () => {
        await sleep(20);
        await insertUser(getDB(), "late");
      })();
      await insertUser(getDB(), "inside");
    });
    await late;
    expect(await names()).toEqual(["inside", "late"]);
  });

  it("never runs an ambient write on the owned connection once the commit began", async () => {
    const leaked: Promise<string | null>[] = [];
    await transaction(async () => {
      await insertUser(getDB(), "inside");
      for (let ticks = 0; ticks < 6; ticks++) {
        const name = `leak${ticks}`;
        leaked.push(
          (async () => {
            for (let i = 0; i < ticks; i++) await Promise.resolve();
            await insertUser(getDB(), name);
            return name;
          })().catch((err: unknown) => {
            // Bound to the transaction before it ended, run after the COMMIT:
            // refused, not silently autocommitted.
            expect(rootMessage(err)).toMatch(/rolled back by the database/);
            return null;
          }),
        );
      }
    });
    const written = (await Promise.all(leaked)).filter((n) => n !== null);
    // Whatever was accepted is there exactly once; whatever was refused is not.
    expect(await names()).toEqual(["inside", ...written].sort());
  });
});

describe("a rollback performed by the engine", () => {
  beforeEach(async () => {
    await withExclusiveClient((c) =>
      c.exec(
        `create trigger kept_test_abort before insert on users
         when new.username = 'boom'
         begin select raise(rollback, 'forced'); end`,
      ),
    );
  });

  it("makes every later statement of the body fail instead of autocommitting", async () => {
    const seen: unknown[] = [];
    const result = await transaction(async (tx) => {
      await insertUser(tx, "before");
      try {
        await insertUser(tx, "boom");
      } catch (err) {
        seen.push(err);
      }
      await insertUser(tx, "after");
    }).catch((err: unknown) => err);
    expect(seen).toHaveLength(1);
    expect(result).toBeInstanceOf(Error);
    expect(rootMessage(result)).toMatch(/rolled back/);
    expect(await names()).toEqual([]);
  });

  it("also covers statements issued through the ambient handle", async () => {
    const result = await transaction(async () => {
      await insertUser(getDB(), "boom").catch(() => undefined);
      await insertUser(getDB(), "after");
    }).catch((err: unknown) => err);
    expect(rootMessage(result)).toMatch(/rolled back/);
    expect(await names()).toEqual([]);
  });
});

describe("concurrent savepoints", () => {
  it("undoes only the failing savepoint when a sibling is still running", async () => {
    const log: string[] = [];
    await transaction(async () => {
      await insertUser(getDB(), "outer");
      const results = await Promise.allSettled([
        transaction(async (tx) => {
          log.push("sp1 start");
          await insertUser(tx, "sp1a");
          await sleep(20);
          await insertUser(tx, "sp1b");
          log.push("sp1 end");
        }),
        transaction(async (tx) => {
          log.push("sp2 start");
          await insertUser(tx, "sp2");
          throw new Error("sp2 fails");
        }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    });
    expect(log).toEqual(["sp1 start", "sp1 end", "sp2 start"]);
    expect(await names()).toEqual(["outer", "sp1a", "sp1b"]);
  });

  it("keeps both when both succeed, in the order they were started", async () => {
    await transaction(async () => {
      await Promise.all([
        transaction(async (tx) => {
          await insertUser(tx, "A");
          await sleep(10);
        }),
        transaction(async (tx) => {
          await insertUser(tx, "B");
        }),
      ]);
    });
    expect(await names()).toEqual(["A", "B"]);
  });

  it("does not deadlock a savepoint nested inside a savepoint", async () => {
    await transaction(async () => {
      await transaction(async () => {
        await insertUser(getDB(), "level1");
        await transaction(async () => {
          await insertUser(getDB(), "level2");
        });
        await Promise.allSettled([
          transaction(async () => {
            await insertUser(getDB(), "level2b");
            throw new Error("no");
          }),
          transaction(async () => {
            await insertUser(getDB(), "level2c");
          }),
        ]);
      });
    });
    expect(await names()).toEqual(["level1", "level2", "level2c"]);
  });

  it("keeps a hook queued by the outer body while a savepoint rolls back", async () => {
    const ran: string[] = [];
    await transaction(async () => {
      afterCommit(() => void ran.push("before"));
      await Promise.allSettled([
        transaction(async () => {
          afterCommit(() => void ran.push("dropped"));
          await sleep(10);
          throw new Error("sp fails");
        }),
        (async () => {
          await sleep(2);
          afterCommit(() => void ran.push("sibling"));
        })(),
      ]);
      afterCommit(() => void ran.push("after"));
    });
    expect(ran.sort()).toEqual(["after", "before", "sibling"]);
  });

  it("keeps the hooks of a savepoint that succeeded next to one that failed", async () => {
    const ran: string[] = [];
    await transaction(async () => {
      await Promise.allSettled([
        transaction(async () => {
          afterCommit(() => void ran.push("sp1"));
          await sleep(10);
        }),
        transaction(async () => {
          afterCommit(() => void ran.push("sp2"));
          throw new Error("sp2 fails");
        }),
      ]);
    });
    expect(ran).toEqual(["sp1"]);
  });

  it("refuses work from a savepoint that already rolled back", async () => {
    let late!: Promise<unknown>;
    await transaction(async () => {
      await transaction(async () => {
        late = (async () => {
          await sleep(10);
          await insertUser(getDB(), "late");
        })().catch((err: unknown) => err);
        throw new Error("sp fails");
      }).catch(() => undefined);
      await sleep(30);
    });
    expect(rootMessage(await late)).toMatch(/rolled back/);
    expect(await names()).toEqual([]);
  });
});

describe("transaction watchdog", () => {
  beforeEach(async () => {
    await closeDatabase(root);
    open({ gateTimeoutMs: 2000, transactionTimeoutMs: 60 });
  });

  it("rolls back a transaction that never settles and frees the gate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hang = new Promise<void>(() => {});
    let late!: Promise<unknown>;
    const stuck = transaction(async (tx) => {
      await insertUser(tx, "stuck");
      late = (async () => {
        await sleep(120);
        await insertUser(getDB(), "after-expiry");
      })();
      await hang;
    });
    stuck.catch(() => undefined);

    const started = Date.now();
    await insertUser(getDB(), "waiter");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await names()).toEqual(["waiter"]);

    await expect(late).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/already finished/) },
    });
    await sleep(10);
    expect(await names()).toEqual(["waiter"]);

    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("hardening.test.ts");
    expect(logged).not.toMatch(/insert/i);
    expect(logged).not.toContain("stuck");
  });

  it("rejects the transaction when its body finally returns after the expiry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      transaction(async (tx) => {
        await insertUser(tx, "slow");
        await sleep(150);
      }),
    ).rejects.toThrow(/already finished/);
    expect(await names()).toEqual([]);
    await insertUser(getDB(), "next");
    expect(await names()).toEqual(["next"]);
  });

  it("leaves a transaction that finishes in time alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await transaction(async (tx) => {
      await insertUser(tx, "quick");
    });
    await sleep(120);
    expect(error).not.toHaveBeenCalled();
    expect(await names()).toEqual(["quick"]);
  });
});

describe("closing the database", () => {
  it("does not wait behind a transaction that never finished", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stuck = transaction(async () => {
      await new Promise<void>(() => {});
    });
    stuck.catch(() => undefined);
    await sleep(5);
    const started = Date.now();
    await closeDatabase(root);
    expect(Date.now() - started).toBeLessThan(500);
    setDB(null);
    open();
  });

  it("lets a leaked transaction end after the gate was reset without failing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const finish = Promise.withResolvers<void>();
    const leaked = transaction(async () => {
      await finish.promise;
    });
    await sleep(5);
    const old = root;
    await closeDatabase(old);
    finish.resolve();
    // The body completes after the database is gone; the outcome is an error,
    // but never a thrown gate-ownership failure that hides it.
    const outcome = await leaked.then(
      () => "committed",
      (err: unknown) => rootMessage(err),
    );
    expect(outcome).not.toMatch(/does not own/);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/does not own/);
    setDB(null);
    open();
  });
});
