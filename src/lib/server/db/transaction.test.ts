import { count, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  afterCommit,
  closeDatabase,
  describeError,
  getDB,
  migrateDatabase,
  openDatabase,
  setDB,
  transaction,
  users,
  withExclusiveClient,
  type DB,
} from "./index";
import { GateTimeoutError } from "./gate";

let root: DB;

beforeEach(() => {
  root = openDatabase(":memory:", { gateTimeoutMs: 400 });
  migrateDatabase(root);
  setDB(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase(root);
  setDB(null);
});

const insertUser = (db: DB, username: string) =>
  db.insert(users).values({ username, passwordHash: "x" });

/** Usernames as seen by the shared connection, bypassing any ambient transaction. */
const names = async () =>
  (
    await root.select({ u: users.username }).from(users).orderBy(users.username)
  ).map((r) => r.u);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settled = async (p: Promise<unknown>, ms = 40) =>
  Promise.race([
    p.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((r) => setTimeout(() => r("pending"), ms)),
  ]);

describe("transaction", () => {
  it("commits and returns the callback's value", async () => {
    const value = await transaction(async (tx) => {
      await insertUser(tx, "alice");
      return 42;
    });
    expect(value).toBe(42);
    expect(await names()).toEqual(["alice"]);
  });

  it("rolls back and rethrows the very same error", async () => {
    const boom = new Error("boom");
    await expect(
      transaction(async (tx) => {
        await insertUser(tx, "alice");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await names()).toEqual([]);
  });

  it("keeps the original error when the rollback has nothing to roll back", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    await expect(
      transaction(async (tx) => {
        await insertUser(tx, "alice");
        // The connection ends the transaction itself (as SQLITE_FULL would).
        await (tx as unknown as { run(q: unknown): Promise<unknown> }).run(
          sql`rollback`,
        );
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(error).not.toHaveBeenCalled();
    expect(await names()).toEqual([]);
    // The gate was released: the next transaction starts normally.
    await transaction(async (tx) => {
      await insertUser(tx, "bob");
    });
    expect(await names()).toEqual(["bob"]);
  });

  it("surfaces a failing commit instead of reporting success", async () => {
    await expect(
      transaction(async (tx) => {
        await insertUser(tx, "alice");
        await (tx as unknown as { run(q: unknown): Promise<unknown> }).run(
          sql`rollback`,
        );
      }),
    ).rejects.toThrow(/no transaction is active/);
    expect(await names()).toEqual([]);
  });

  it("rolls back a failed statement's earlier writes", async () => {
    await insertUser(getDB(), "dup");
    await expect(
      transaction(async (tx) => {
        await insertUser(tx, "fresh");
        await insertUser(tx, "dup");
      }),
    ).rejects.toThrow();
    expect(await names()).toEqual(["dup"]);
  });

  it("makes getDB() return the transaction inside it", async () => {
    await expect(
      transaction(async () => {
        await insertUser(getDB(), "alice");
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await names()).toEqual([]);
  });

  it("lets a db captured before the transaction join it", async () => {
    const captured = getDB();
    await expect(
      transaction(async () => {
        await insertUser(captured, "alice");
        const [{ n }] = await captured.select({ n: count() }).from(users);
        expect(n).toBe(1);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await names()).toEqual([]);
  });

  it("does not offer db.transaction() on the shared handle", () => {
    expect(
      () => (getDB() as unknown as { transaction: unknown }).transaction,
    ).toThrow(/use transaction\(\)/);
  });

  it("leaves the sync-style shortcuts off the facade's type", () => {
    // Compile-time only: never called, the directives are the assertions.
    const never = (db: DB) => {
      // @ts-expect-error run() is not part of DB: queries are awaited builders
      void db.run;
      // @ts-expect-error all() is not part of DB
      void db.all;
      // @ts-expect-error get() is not part of DB
      void db.get;
      // @ts-expect-error values() is not part of DB
      void db.values;
      // @ts-expect-error batch() is not part of DB
      void db.batch;
    };
    expect(never).toBeTypeOf("function");
  });

  it("serialises read-modify-write transactions without lost updates", async () => {
    await getDB()
      .insert(users)
      .values({ username: "counter", passwordHash: "x", displayName: "0" });
    const bump = () =>
      transaction(async (tx) => {
        const [row] = await tx
          .select({ v: users.displayName })
          .from(users)
          .where(eq(users.username, "counter"));
        await Promise.resolve();
        await tx
          .update(users)
          .set({ displayName: String(Number(row!.v) + 1) })
          .where(eq(users.username, "counter"));
      });
    await Promise.all(Array.from({ length: 25 }, bump));
    const [row] = await root
      .select({ v: users.displayName })
      .from(users)
      .where(eq(users.username, "counter"));
    expect(row!.v).toBe("25");
  });
});

describe("isolation through the gate", () => {
  it("keeps a plain query out of an open transaction and runs it after commit", async () => {
    const hold = deferred();
    const inside = deferred();
    const tx = transaction(async (t) => {
      await insertUser(t, "pending");
      inside.resolve();
      await hold.promise;
    });
    await inside.promise;

    // `root` is the shared connection, as another request would see it.
    const plain = root.select({ u: users.username }).from(users);
    expect(await settled(plain)).toBe("pending");

    hold.resolve();
    await tx;
    // It ran after the commit, never in the middle of the transaction.
    expect(await plain).toEqual([{ u: "pending" }]);
  });

  it("shows a plain query nothing from a transaction that rolls back", async () => {
    const hold = deferred();
    const inside = deferred();
    const tx = transaction(async (t) => {
      await insertUser(t, "never");
      inside.resolve();
      await hold.promise;
      throw new Error("abort");
    });
    const caught = tx.catch((e: Error) => e.message);
    await inside.promise;
    const plain = root.select({ u: users.username }).from(users);
    hold.resolve();
    expect(await caught).toBe("abort");
    expect(await plain).toEqual([]);
  });

  it("serves waiters strictly in arrival order, queries and transactions alike", async () => {
    const hold = deferred();
    const inside = deferred();
    const order: string[] = [];
    const first = transaction(async (t) => {
      await insertUser(t, "a");
      inside.resolve();
      await hold.promise;
      order.push("first");
    });
    await inside.promise;

    const q1 = root
      .select({ n: count() })
      .from(users)
      .then((r) => {
        order.push(`q1:${r[0]!.n}`);
      });
    const second = transaction(async (t) => {
      await insertUser(t, "b");
      order.push("second");
    });
    const q2 = root
      .select({ n: count() })
      .from(users)
      .then((r) => {
        order.push(`q2:${r[0]!.n}`);
      });

    hold.resolve();
    await Promise.all([first, q1, second, q2]);
    expect(order).toEqual(["first", "q1:1", "second", "q2:2"]);
  });

  it("never runs a query while the connection is mid-transaction", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2
          ? root.select({ n: count() }).from(users)
          : transaction(async (t) => {
              await insertUser(t, `u${i}`);
              await Promise.resolve();
              await t.select({ n: count() }).from(users);
            }),
      ),
    );
    expect(results).toHaveLength(20);
    expect(await names()).toHaveLength(10);
  });

  it("rejects a transaction handle used after the transaction ended", async () => {
    let leaked!: DB;
    await transaction(async (tx) => {
      leaked = tx;
    });
    await expect(leaked.select().from(users)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/already finished/) },
    });
    await expect(insertUser(leaked, "x")).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/already finished/) },
    });
    expect(await names()).toEqual([]);
  });

  it("does not let detached work reuse a finished transaction", async () => {
    const detached = deferred();
    await transaction(async () => {
      setTimeout(() => {
        void (async () => {
          try {
            // Same async context as the transaction, but it is over by now.
            await insertUser(getDB(), "late");
            detached.resolve();
          } catch (err) {
            detached.reject(err);
          }
        })();
      }, 20);
      await insertUser(getDB(), "inside");
    });
    await detached.promise;
    // The late write went to the shared connection and is its own statement.
    expect(await names()).toEqual(["inside", "late"]);
  });

  it("starts a fresh transaction, not a savepoint, from detached work", async () => {
    const detached = deferred();
    await transaction(async () => {
      setTimeout(() => {
        void transaction(async (tx) => {
          await insertUser(tx, "detached");
        }).then(detached.resolve, detached.reject);
      }, 10);
    });
    await detached.promise;
    expect(await names()).toEqual(["detached"]);
  });
});

describe("savepoints", () => {
  it("rolls back an inner transaction and still commits the outer one", async () => {
    await transaction(async (tx) => {
      await insertUser(tx, "outer");
      await expect(
        transaction(async () => {
          await insertUser(getDB(), "inner");
          throw new Error("inner failed");
        }),
      ).rejects.toThrow("inner failed");
      await insertUser(tx, "outer2");
    });
    expect(await names()).toEqual(["outer", "outer2"]);
  });

  it("keeps the inner work when it succeeds, and drops everything if the outer fails", async () => {
    await transaction(async () => {
      await transaction(async (tx) => {
        await insertUser(tx, "inner");
      });
    });
    expect(await names()).toEqual(["inner"]);

    await expect(
      transaction(async () => {
        await transaction(async (tx) => {
          await insertUser(tx, "doomed");
        });
        throw new Error("outer failed");
      }),
    ).rejects.toThrow("outer failed");
    expect(await names()).toEqual(["inner"]);
  });

  it("nests several levels and rolls back only the failing one", async () => {
    await transaction(async () => {
      await insertUser(getDB(), "l0");
      await transaction(async () => {
        await insertUser(getDB(), "l1");
        await expect(
          transaction(async () => {
            await insertUser(getDB(), "l2");
            throw new Error("l2");
          }),
        ).rejects.toThrow("l2");
      });
    });
    expect(await names()).toEqual(["l0", "l1"]);
  });

  it("passes the same transaction to the inner callback", async () => {
    await transaction(async (outer) => {
      await transaction(async (inner) => {
        expect(inner).toBe(outer);
      });
    });
  });
});

describe("afterCommit", () => {
  it("runs after the commit, with the connection released", async () => {
    const seen: string[] = [];
    await transaction(async (tx) => {
      await insertUser(tx, "alice");
      afterCommit(async () => {
        seen.push(`hook sees ${(await names()).join(",")}`);
        // The gate is free again: a hook may start its own transaction.
        await transaction(async (t) => {
          await insertUser(t, "from-hook");
        });
      });
      seen.push("body done");
    });
    expect(seen).toEqual(["body done", "hook sees alice"]);
    expect(await names()).toEqual(["alice", "from-hook"]);
  });

  it("runs hooks in registration order, after the transaction function returned", async () => {
    const order: number[] = [];
    await transaction(async () => {
      afterCommit(() => void order.push(1));
      afterCommit(async () => {
        await Promise.resolve();
        order.push(2);
      });
      afterCommit(() => void order.push(3));
      expect(order).toEqual([]);
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("never runs when the transaction rolls back", async () => {
    const hook = vi.fn();
    await expect(
      transaction(async () => {
        afterCommit(hook);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(hook).not.toHaveBeenCalled();
  });

  it("never runs when the commit itself fails", async () => {
    const hook = vi.fn();
    await expect(
      transaction(async (tx) => {
        afterCommit(hook);
        await (tx as unknown as { run(q: unknown): Promise<unknown> }).run(
          sql`rollback`,
        );
      }),
    ).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it("drops the entries of a rolled-back savepoint and keeps the others", async () => {
    const ran: string[] = [];
    await transaction(async () => {
      afterCommit(() => void ran.push("outer-before"));
      await expect(
        transaction(async () => {
          afterCommit(() => void ran.push("inner"));
          throw new Error("inner failed");
        }),
      ).rejects.toThrow();
      await transaction(async () => {
        afterCommit(() => void ran.push("inner-ok"));
      });
      afterCommit(() => void ran.push("outer-after"));
    });
    expect(ran).toEqual(["outer-before", "inner-ok", "outer-after"]);
  });

  it("logs a failing hook by code only, still runs the rest and does not fail the commit", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran = vi.fn();
    await transaction(async (tx) => {
      await insertUser(tx, "alice");
      afterCommit(() => {
        throw new Error("secret counterparty");
      });
      afterCommit(async () => {
        await Promise.reject(new Error("another secret"));
      });
      afterCommit(ran);
    });
    expect(ran).toHaveBeenCalledOnce();
    expect(await names()).toEqual(["alice"]);
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });

  it("makes getDB() inside a hook the shared connection", async () => {
    await transaction(async () => {
      afterCommit(async () => {
        await insertUser(getDB(), "hooked");
      });
    });
    expect(await names()).toEqual(["hooked"]);
  });

  it("runs immediately outside a transaction", async () => {
    const hook = vi.fn();
    afterCommit(hook);
    await Promise.resolve();
    expect(hook).toHaveBeenCalledOnce();
  });
});

describe("gate timeout", () => {
  it("fails a waiter that waits too long and names the blocking transaction", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hold = deferred();
    const inside = deferred();
    const blocker = transaction(async () => {
      inside.resolve();
      await hold.promise;
    });
    await inside.promise;

    // Plain queries go through drizzle, which wraps what its driver throws.
    await expect(root.select().from(users)).rejects.toMatchObject({
      cause: expect.any(GateTimeoutError),
    });
    await expect(transaction(async () => undefined)).rejects.toBeInstanceOf(
      GateTimeoutError,
    );
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0]!.join(" ")).toContain("transaction.test.ts");

    // The blocker is unaffected and the gate recovers.
    hold.resolve();
    await blocker;
    await insertUser(getDB(), "after");
    expect(await names()).toEqual(["after"]);
  });
});

describe("withExclusiveClient", () => {
  it("waits for an open transaction and blocks queries while it runs", async () => {
    const hold = deferred();
    const inside = deferred();
    const tx = transaction(async (t) => {
      await insertUser(t, "alice");
      inside.resolve();
      await hold.promise;
    });
    await inside.promise;

    const release = deferred();
    const entered = deferred();
    const exclusive = withExclusiveClient(async (client) => {
      entered.resolve();
      await release.promise;
      return client.query("SELECT count(*) AS n FROM users").values();
    });
    expect(await settled(entered.promise)).toBe("pending");
    hold.resolve();
    await tx;
    await entered.promise;

    const plain = root.select({ n: count() }).from(users);
    expect(await settled(plain)).toBe("pending");
    release.resolve();
    expect(await exclusive).toEqual([[1]]);
    expect(await plain).toEqual([{ n: 1 }]);
  });

  it("is refused inside a transaction, where it would wait for itself", async () => {
    await expect(
      transaction(async () => {
        await withExclusiveClient(() => undefined);
      }),
    ).rejects.toThrow(/inside a transaction/);
  });
});

describe("error hygiene", () => {
  it("describeError never carries the SQL or the bound values of a failed query", async () => {
    await insertUser(getDB(), "dup");
    let caught: unknown;
    try {
      await getDB()
        .insert(users)
        .values({ username: "dup", passwordHash: "$argon2id$secret-hash" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // The driver's own message does carry them, which is why nothing logs it.
    expect((caught as Error).message).toContain("secret-hash");
    const described = describeError(caught);
    expect(described).not.toContain("secret-hash");
    expect(described).not.toContain("insert");
    expect(described).toContain("SQLITE_CONSTRAINT_UNIQUE");
  });
});

describe("statement cache", () => {
  it("keeps working past its capacity and when a statement is reused after eviction", async () => {
    await insertUser(getDB(), "alice");
    const query = (i: number) =>
      getDB()
        .select({ n: sql<number>`${sql.raw(String(i))}` })
        .from(users);
    for (let i = 0; i < 700; i++) {
      expect(await query(i)).toEqual([{ n: i }]);
    }
    expect(await query(0)).toEqual([{ n: 0 }]);
    expect(await query(699)).toEqual([{ n: 699 }]);
  });

  it("reuses a statement after it failed", async () => {
    await insertUser(getDB(), "dup");
    for (let i = 0; i < 3; i++) {
      await expect(insertUser(getDB(), "dup")).rejects.toThrow();
    }
    await insertUser(getDB(), "fine");
    expect(await names()).toEqual(["dup", "fine"]);
  });
});
