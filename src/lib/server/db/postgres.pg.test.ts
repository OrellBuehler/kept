/**
 * PostgreSQL integration tests. They need a server: set KEPT_TEST_DATABASE_URL
 * to an admin connection (each test file creates and drops its own databases)
 * and run `bun run test:pg`, which also gives the process a PostgreSQL-dialect
 * schema. Without the variable every suite here is skipped.
 */
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrizzleQueryError, and, count, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { minor } from "$lib/money";
import { allocateInTx } from "$lib/server/bills/allocations";
import { updateBill } from "$lib/server/bills/bills";
import { runAutoMatching } from "$lib/server/bills/suggestions";
import { billInput, seedBill } from "$lib/testing/bills";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { createFirstAdmin, createUser } from "$lib/server/auth/users";
import { describeError } from "$lib/server/errors";
import { createManualTransaction, listTransactions } from "$lib/server/ledger";
import { currentBalance } from "$lib/server/ledger/balances";
import { listAccounts } from "$lib/server/ledger/accounts";
import { createTestUser } from "$lib/testing/auth";
import {
  seedAccount,
  seedImport,
  seedImportedTransaction,
} from "$lib/testing/ledger";
import { readDatabaseConfig, type PostgresDatabaseConfig } from "./config";
import { dialect } from "./dialect";
import {
  afterCommit,
  billAllocations,
  closeDatabase,
  getDB,
  institutions,
  isUniqueViolation,
  migrateDatabase,
  openPostgresDatabase,
  paperlessConnections,
  setDB,
  transaction,
  transactions,
  users,
  withExclusiveClient,
  type DB,
} from "./index";
import { MIGRATION_LOCK_KEY, migratePostgres, openPostgres } from "./postgres";

const adminUrl = process.env.KEPT_TEST_DATABASE_URL;
const enabled = dialect === "pg" && !!adminUrl;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function urlFor(name: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${name}`;
  return u.toString();
}

function configFor(
  name: string,
  env: Record<string, string> = {},
): PostgresDatabaseConfig {
  const config = readDatabaseConfig({
    DATABASE_URL: urlFor(name),
    KEPT_DB_POOL_MAX: "5",
    KEPT_DB_APPLICATION_NAME: "kept-test",
    ...env,
  });
  if (config.kind !== "postgres") throw new Error("expected postgres");
  return config;
}

let admin: Bun.SQL;
const created: string[] = [];

async function createScratch(): Promise<string> {
  const name = `kept_test_${crypto.randomUUID().replace(/-/g, "")}`;
  await admin.unsafe(`create database ${name}`);
  created.push(name);
  return name;
}

async function dropScratch(name: string): Promise<void> {
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  created.splice(created.indexOf(name), 1);
}

/** A raw second client on the scratch database: sees only committed data. */
function rawClient(name: string): Bun.SQL {
  return new Bun.SQL({ url: urlFor(name), max: 3 });
}

beforeAll(() => {
  if (enabled) admin = new Bun.SQL({ url: adminUrl, max: 2 });
});

afterAll(async () => {
  if (!enabled) return;
  for (const name of [...created]) await dropScratch(name);
  await admin.close({ timeout: 0 });
});

const migrationFiles = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "drizzle", "postgres", "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: unknown[] }
).entries.length;

describe.skipIf(!enabled)("postgres migrations", () => {
  let name: string;
  let raw: Bun.SQL;
  let dbs: DB[] = [];

  beforeEach(async () => {
    name = await createScratch();
    raw = rawClient(name);
    dbs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const db of dbs) await closeDatabase(db);
    await raw.close({ timeout: 0 });
    await dropScratch(name);
  });

  const open = (env: Record<string, string> = {}) => {
    const db = openPostgresDatabase(configFor(name, env));
    dbs.push(db);
    return db;
  };

  const history = async () =>
    (await raw.unsafe(
      "select hash, created_at from drizzle.__drizzle_migrations order by id",
    )) as { hash: string; created_at: string }[];

  const tableCount = async () =>
    Number(
      (
        (await raw.unsafe(
          "select count(*) as n from information_schema.tables where table_schema = 'public'",
        )) as { n: string }[]
      )[0]!.n,
    );

  it("applies the baseline to an empty database", async () => {
    await migrateDatabase(open());
    expect(await tableCount()).toBeGreaterThan(40);
    expect(await history()).toHaveLength(migrationFiles);
  });

  it("keeps drizzle's history out of the application schema", async () => {
    await migrateDatabase(open());
    const [row] = (await raw.unsafe(
      "select count(*) as n from information_schema.tables where table_name = '__drizzle_migrations' and table_schema = 'public'",
    )) as { n: string }[];
    expect(Number(row!.n)).toBe(0);
  });

  it("is a no-op the second time", async () => {
    const db = open();
    await migrateDatabase(db);
    const before = await history();
    await migrateDatabase(db);
    expect(await history()).toEqual(before);
  });

  it("lets three concurrent runners all succeed, with one history row", async () => {
    const runners = [open(), open(), open()];
    const results = await Promise.allSettled(
      runners.map((db) => migrateDatabase(db)),
    );
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(await history()).toHaveLength(migrationFiles);
    expect(await tableCount()).toBeGreaterThan(40);
  });

  it("waits while another session holds the migration lock", async () => {
    const holder = await raw.reserve();
    await holder.unsafe("select pg_advisory_lock(hashtextextended($1, 0))", [
      MIGRATION_LOCK_KEY,
    ]);
    let done = false;
    const run = migrateDatabase(open()).then(() => {
      done = true;
    });
    await sleep(600);
    expect(done).toBe(false);
    expect(await tableCount()).toBe(0);
    await holder.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [
      MIGRATION_LOCK_KEY,
    ]);
    holder.release();
    await run;
    expect(done).toBe(true);
    expect(await tableCount()).toBeGreaterThan(40);
  });

  it("releases the lock, and leaves no partial schema, when a migration fails", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kept-bad-migration-"));
    try {
      mkdirSync(join(folder, "meta"));
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1_700_000_000_000,
              tag: "0000_bad",
              breakpoints: true,
            },
          ],
        }),
      );
      writeFileSync(
        join(folder, "0000_bad.sql"),
        'create table "half_done" ("id" text);--> statement-breakpoint\nselect * from "missing_table";',
      );
      const backend = openPostgres(configFor(name));
      try {
        await expect(migratePostgres(backend, folder)).rejects.toBeInstanceOf(
          DrizzleQueryError,
        );
      } finally {
        await backend.close();
      }
      expect(await tableCount()).toBe(0);
      // The session lock is gone: another connection can take it at once.
      const [row] = (await raw.unsafe(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as got",
        [MIGRATION_LOCK_KEY],
      )) as { got: boolean }[];
      expect(row!.got).toBe(true);
      await raw.unsafe("select pg_advisory_unlock_all()");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("runs migrations without the pool's statement and transaction timeouts", async () => {
    const db = open({
      KEPT_DB_STATEMENT_TIMEOUT_MS: "1",
      KEPT_DB_TRANSACTION_TIMEOUT_MS: "1",
    });
    await migrateDatabase(db);
    expect(await history()).toHaveLength(migrationFiles);
  });
});

describe.skipIf(!enabled)("postgres backend", () => {
  let name: string;
  let raw: Bun.SQL;
  let db: DB;

  async function start(env: Record<string, string> = {}) {
    db = openPostgresDatabase(configFor(name, env));
    await migrateDatabase(db);
    setDB(db);
  }

  beforeEach(async () => {
    name = await createScratch();
    raw = rawClient(name);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db) await closeDatabase(db);
    setDB(null);
    await raw.close({ timeout: 0 });
    await dropScratch(name);
  });

  const insertUser = (
    username: string,
    extra: { passwordHash?: string } = {},
  ) =>
    getDB()
      .insert(users)
      .values({ username, passwordHash: extra.passwordHash ?? "x" });

  const countUsers = async (client: Bun.SQL = raw) =>
    Number(
      (
        (await client.unsafe("select count(*) as n from users")) as {
          n: string;
        }[]
      )[0]!.n,
    );

  /** A select without a table: drizzle needs a source, so use a one-row subquery. */
  const one = sql`(select 1) as one`;
  const pid = async () =>
    (
      await getDB()
        .select({ pid: sql<number>`pg_backend_pid()`.mapWith(Number) })
        .from(one)
    )[0]!.pid;

  describe("session and pool", () => {
    it("applies the session parameters to every pooled connection", async () => {
      await start({
        KEPT_DB_POOL_MAX: "3",
        KEPT_DB_STATEMENT_TIMEOUT_MS: "12345",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "23456",
        KEPT_DB_APPLICATION_NAME: "kept-params",
      });
      const rows = await Promise.all(
        [0, 1, 2, 3, 4, 5].map(() =>
          getDB()
            .select({
              pid: sql<number>`pg_backend_pid()`.mapWith(Number),
              statement: sql<string>`current_setting('statement_timeout')`,
              transaction: sql<string>`(select pg_sleep(0.2))::text || current_setting('transaction_timeout')`,
              app: sql<string>`current_setting('application_name')`,
            })
            .from(one),
        ),
      );
      const seen = rows.map((r) => r[0]!);
      expect(new Set(seen.map((r) => r.pid)).size).toBeGreaterThan(1);
      for (const r of seen) {
        expect(r.statement).toBe("12345ms");
        expect(r.transaction).toBe("23456ms");
        expect(r.app).toBe("kept-params");
      }
    });

    it("never opens more connections than the pool's max", async () => {
      await start({ KEPT_DB_POOL_MAX: "2" });
      const rows = await Promise.all(
        Array.from({ length: 8 }, () =>
          getDB()
            .select({
              pid: sql<number>`pg_backend_pid()`.mapWith(Number),
              slept: sql<string>`pg_sleep(0.1)::text`,
            })
            .from(one),
        ),
      );
      expect(new Set(rows.map((r) => r[0]!.pid)).size).toBeLessThanOrEqual(2);
    });

    it("enforces the statement timeout and stays usable", async () => {
      await start({ KEPT_DB_STATEMENT_TIMEOUT_MS: "200" });
      const error = await getDB()
        .select({ x: sql`pg_sleep(2)` })
        .from(one)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(DrizzleQueryError);
      expect(describeError(error)).toContain("sqlstate=57014");
      expect(await countUsers()).toBe(0);
      await insertUser("after-timeout");
      expect(await countUsers()).toBe(1);
    });

    it("reuses one pool for the process-wide database across module reloads", () => {
      const config = configFor(name);
      const a = openPostgres(config, { shared: true });
      const b = openPostgres(config, { shared: true });
      expect(b.client).toBe(a.client);
      const other = openPostgres(configFor(name, { KEPT_DB_POOL_MAX: "2" }), {
        shared: true,
      });
      expect(other.client).not.toBe(a.client);
      return Promise.all([a.close(), b.close(), other.close()]).then(() => {
        const fresh = openPostgres(config, { shared: true });
        expect(fresh.client).not.toBe(a.client);
        return fresh.close();
      });
    });

    it("rejects withExclusiveClient, which is only for SQLite backups", async () => {
      await start();
      await expect(withExclusiveClient(() => 1)).rejects.toThrow(
        /only supported on SQLite/,
      );
    });
  });

  describe("transaction facade", () => {
    beforeEach(() => start());

    it("commits and returns the callback's value", async () => {
      const value = await transaction(async (tx) => {
        await tx.insert(users).values({ username: "a", passwordHash: "x" });
        return 42;
      });
      expect(value).toBe(42);
      expect(await countUsers()).toBe(1);
    });

    it("rolls back and rethrows the original error", async () => {
      const boom = new Error("boom");
      const error = await transaction(async (tx) => {
        await tx.insert(users).values({ username: "a", passwordHash: "x" });
        throw boom;
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBe(boom);
      expect(await countUsers()).toBe(0);
    });

    it("pins getDB() to the transaction's connection, and only inside it", async () => {
      const outside = await Promise.all(
        [0, 1, 2].map(() =>
          getDB()
            .select({
              pid: sql<number>`pg_backend_pid()`.mapWith(Number),
              s: sql<string>`pg_sleep(0.15)::text`,
            })
            .from(one),
        ),
      );
      expect(new Set(outside.map((r) => r[0]!.pid)).size).toBeGreaterThan(1);

      await transaction(async (tx) => {
        const mine = (
          await tx
            .select({ pid: sql<number>`pg_backend_pid()`.mapWith(Number) })
            .from(one)
        )[0]!.pid;
        const viaAmbient = await Promise.all([0, 1, 2, 3].map(() => pid()));
        expect(new Set(viaAmbient)).toEqual(new Set([mine]));
        await insertUser("pinned");
        // Another connection cannot see the uncommitted row.
        expect(await countUsers()).toBe(0);
        expect((await getDB().select({ n: count() }).from(users))[0]!.n).toBe(
          1,
        );
      });
      expect(await countUsers()).toBe(1);
    });

    it("lets a db captured before the transaction join it", async () => {
      const captured = getDB();
      await transaction(async () => {
        await captured
          .insert(users)
          .values({ username: "c", passwordHash: "x" });
        expect(await countUsers()).toBe(0);
      });
      expect(await countUsers()).toBe(1);
    });

    it("refuses a statement on the transaction object after it ended", async () => {
      let kept: DB | undefined;
      await transaction(async (tx) => {
        kept = tx;
      });
      const error = await kept!
        .select()
        .from(users)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(DrizzleQueryError);
      expect(((error as DrizzleQueryError).cause as Error).message).toMatch(
        /already finished/,
      );
    });

    it("rolls back only the savepoint when a nested transaction throws", async () => {
      await transaction(async (tx) => {
        await tx.insert(users).values({ username: "outer", passwordHash: "x" });
        await expect(
          transaction(async (inner) => {
            await inner
              .insert(users)
              .values({ username: "inner", passwordHash: "x" });
            throw new Error("inner failed");
          }),
        ).rejects.toThrow("inner failed");
        await transaction(async (inner) => {
          await inner
            .insert(users)
            .values({ username: "inner-ok", passwordHash: "x" });
        });
      });
      const names = (
        (await raw.unsafe("select username from users order by username")) as {
          username: string;
        }[]
      ).map((r) => r.username);
      expect(names).toEqual(["inner-ok", "outer"]);
    });

    it("survives a unique violation inside a savepoint that the outer code handles", async () => {
      await insertUser("taken");
      const result = await transaction(async (tx) => {
        const error = await transaction(async () => {
          await insertUser("taken");
        }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(isUniqueViolation(error)).toBe(true);
        await tx.insert(users).values({ username: "next", passwordHash: "x" });
        return "committed";
      });
      expect(result).toBe("committed");
      expect(await countUsers()).toBe(2);
    });

    it("runs afterCommit hooks after the commit, with the data visible", async () => {
      const seen: number[] = [];
      await transaction(async () => {
        await insertUser("h");
        afterCommit(async () => {
          seen.push(await countUsers());
        });
        expect(seen).toEqual([]);
      });
      expect(seen).toEqual([1]);
    });

    it("drops hooks of a rolled-back transaction and of a rolled-back savepoint", async () => {
      const ran: string[] = [];
      await transaction(async () => {
        afterCommit(() => {
          ran.push("outer");
        });
        await transaction(async () => {
          afterCommit(() => {
            ran.push("rolled-back savepoint");
          });
          throw new Error("no");
        }).catch(() => undefined);
        await transaction(async () => {
          afterCommit(() => {
            ran.push("released savepoint");
          });
        });
      });
      expect(ran).toEqual(["outer", "released savepoint"]);

      await transaction(async () => {
        afterCommit(() => {
          ran.push("never");
        });
        throw new Error("rollback");
      }).catch(() => undefined);
      expect(ran).not.toContain("never");
    });

    it("runs concurrent transactions on separate connections", async () => {
      const pids = await Promise.all(
        [0, 1, 2, 3].map(() =>
          transaction(async () => {
            const p = await pid();
            await sleep(100);
            return p;
          }),
        ),
      );
      expect(new Set(pids).size).toBe(4);
    });

    it("completes more concurrent transactions than the pool has connections", async () => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          transaction(async (tx) => {
            await tx
              .insert(users)
              .values({ username: `u${i}`, passwordHash: "x" });
            await sleep(20);
          }),
        ),
      );
      expect(await countUsers()).toBe(20);
    });

    describe("lock", () => {
      it("serialises transactions holding the same key", async () => {
        const log: string[] = [];
        const a = transaction(
          async () => {
            log.push("A got");
            await sleep(400);
            log.push("A done");
          },
          { lock: "same" },
        );
        await sleep(100);
        const b = transaction(
          async () => {
            log.push("B got");
          },
          { lock: "same" },
        );
        await Promise.all([a, b]);
        expect(log).toEqual(["A got", "A done", "B got"]);
      });

      it("does not hold up a different key", async () => {
        const log: string[] = [];
        const a = transaction(
          async () => {
            log.push("A got");
            await sleep(400);
            log.push("A done");
          },
          { lock: "one" },
        );
        await sleep(100);
        await transaction(
          async () => {
            log.push("B got");
          },
          { lock: "two" },
        );
        await a;
        expect(log).toEqual(["A got", "B got", "A done"]);
      });

      it("reports a wait longer than the statement timeout as a conflict", async () => {
        await closeDatabase(db);
        await start({ KEPT_DB_STATEMENT_TIMEOUT_MS: "300" });
        const holder = transaction(() => sleep(1200), { lock: "busy" });
        await sleep(100);
        const error = await transaction(async () => undefined, {
          lock: "busy",
        }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toMatchObject({ name: "LedgerError", code: "conflict" });
        await holder;
        await transaction(async () => undefined, { lock: "busy" });
      });

      it("is released when the transaction rolls back", async () => {
        await transaction(
          async () => {
            throw new Error("x");
          },
          { lock: "r" },
        ).catch(() => undefined);
        await transaction(async () => undefined, { lock: "r" });
      });

      it("is taken by a nested call and held until the outer transaction ends", async () => {
        const log: string[] = [];
        const outer = transaction(async () => {
          await transaction(
            async () => {
              log.push("inner");
            },
            { lock: "nested" },
          );
          await sleep(400);
          log.push("outer done");
        });
        await sleep(100);
        await transaction(
          async () => {
            log.push("other");
          },
          { lock: "nested" },
        );
        await outer;
        expect(log).toEqual(["inner", "outer done", "other"]);
      });

      it("lets only one concurrent first admin through", async () => {
        const results = await Promise.allSettled(
          [0, 1, 2, 3, 4].map((i) =>
            createFirstAdmin({
              username: `admin${i}`,
              password: "correct-horse-battery",
              displayName: null,
            }),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          results
            .filter((r) => r.status === "rejected")
            .every(
              (r) => (r.reason as { code?: string }).code === "setup_closed",
            ),
        ).toBe(true);
        expect(await countUsers()).toBe(1);
      });
    });
  });

  describe("transaction timeout", () => {
    it("ends a transaction held too long and keeps the pool usable", async () => {
      await start({
        KEPT_DB_POOL_MAX: "2",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "300",
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = await transaction(async (tx) => {
        await tx.insert(users).values({ username: "slow", passwordHash: "x" });
        await sleep(900);
        await tx.insert(users).values({ username: "late", passwordHash: "x" });
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).not.toBeNull();
      expect(await countUsers()).toBe(0);
      spy.mockRestore();
      // Both pool slots still work, including the one that was killed.
      await Promise.all([insertUser("p1"), insertUser("p2"), insertUser("p3")]);
      expect(await countUsers()).toBe(3);
    });
  });

  describe("hung transaction bodies", () => {
    it("recovers every pool slot from bodies that never settle", async () => {
      await start({
        KEPT_DB_POOL_MAX: "3",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "300",
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const hung = [0, 1, 2].map(() =>
        transaction(async (tx) => {
          await tx.select({ x: sql`1` }).from(users);
          await new Promise<never>(() => {});
        }),
      );
      const outcomes = hung.map((h) =>
        Promise.race([
          h.then(
            () => "settled",
            () => "settled",
          ),
          sleep(5000).then(() => "hung"),
        ]),
      );
      await sleep(1500);
      const done = await Promise.race([
        Promise.all(
          [0, 1, 2, 3, 4].map((i) =>
            transaction(async (tx) => {
              await tx
                .insert(users)
                .values({ username: `ok${i}`, passwordHash: "x" });
            }),
          ),
        ).then(() => "done"),
        sleep(4000).then(() => "stuck"),
      ]);
      expect(done).toBe("done");
      expect(await countUsers()).toBe(5);
      const logged = spy.mock.calls.map((c) => String(c[0]) + String(c[2]));
      expect(logged.some((l) => l.includes("Started at"))).toBe(true);
      await Promise.all(outcomes);
    }, 20_000);

    it("fails the late body's next statement instead of hanging", async () => {
      await start({
        KEPT_DB_POOL_MAX: "1",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "200",
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const error = await transaction(async (tx) => {
        await sleep(1200);
        await tx.insert(users).values({ username: "late", passwordHash: "x" });
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).not.toBeNull();
      expect(await countUsers()).toBe(0);
    });
  });

  describe("late bodies", () => {
    it("does not report a commit for a body that returns after the watchdog", async () => {
      await start({
        KEPT_DB_POOL_MAX: "1",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "200",
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const error = await transaction(async () => {
        await sleep(1200);
        return "done";
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((error as Error).message).toMatch(/open too long/);
      await insertUser("after");
      expect(await countUsers()).toBe(1);
    });
  });

  describe("errors", () => {
    beforeEach(() => start());

    it("maps a real unique violation without leaking row data", async () => {
      const secret = "SECRET-HASH-do-not-log";
      await insertUser("dup", { passwordHash: secret });
      const error = await insertUser("dup", { passwordHash: secret }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DrizzleQueryError);
      const cause = (error as DrizzleQueryError).cause as {
        errno?: string;
        constraint?: string;
      };
      expect(cause.errno).toBe("23505");
      expect(isUniqueViolation(error)).toBe(true);
      const described = describeError(error);
      expect(described).toContain("sqlstate=23505");
      expect(described).toContain("constraint=users_username_unique");
      for (const forbidden of [secret, "dup", "insert", "Key (", "params"]) {
        expect(described).not.toContain(forbidden);
      }
    });

    it("does not call a not-null or foreign-key violation unique", async () => {
      const notNull = await getDB()
        .insert(users)
        .values({ username: "n", passwordHash: null as never })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(describeError(notNull)).toContain("sqlstate=23502");
      expect(isUniqueViolation(notNull)).toBe(false);

      const fk = await getDB()
        .insert(transactions)
        .values({
          userId: crypto.randomUUID(),
          accountId: crypto.randomUUID(),
          source: "manual",
          externalId: "x",
          bookingDate: "2024-01-01",
          amount: minor(1),
          currency: "CHF",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(describeError(fk)).toContain("sqlstate=23503");
      expect(isUniqueViolation(fk)).toBe(false);
    });

    it("maps a duplicate username to the domain error", async () => {
      await createUser({
        username: "same",
        password: "correct-horse-battery",
        role: "member",
        displayName: null,
      });
      await expect(
        createUser({
          username: "same",
          password: "correct-horse-battery",
          role: "member",
          displayName: null,
        }),
      ).rejects.toMatchObject({ code: "username_taken" });
    });
  });

  describe("column types through the real schema", () => {
    beforeEach(() => start());

    it("round-trips json as a document, not a string", async () => {
      const user = await createTestUser();
      const mapping = {
        amount: 3,
        statusValues: { open: "Open", paid: "Paid" },
      };
      await getDB()
        .insert(paperlessConnections)
        .values({
          userId: user.id,
          baseUrl: "https://paperless.example.invalid",
          tokenEncrypted: "x",
          webhookSecretHash: "h",
          webhookToken: "t",
          billSource: { kind: "tag", id: 7, label: "Bills" },
          fieldMapping: mapping,
          lastSyncModified: 2 ** 40,
        });
      const [row] = await getDB()
        .select()
        .from(paperlessConnections)
        .where(eq(paperlessConnections.userId, user.id));
      expect(row!.billSource).toEqual({ kind: "tag", id: 7, label: "Bills" });
      expect(row!.fieldMapping).toEqual(mapping);
      expect(row!.lastSyncModified).toBe(2 ** 40);
      const [stored] = (await raw.unsafe(
        "select json_typeof(bill_source) as t, field_mapping->'statusValues'->>'paid' as paid from paperless_connections",
      )) as { t: string; paid: string }[];
      expect(stored).toEqual({ t: "object", paid: "Paid" });

      await getDB()
        .update(paperlessConnections)
        .set({ billSource: null, fieldMapping: null })
        .where(eq(paperlessConnections.userId, user.id));
      const [cleared] = await getDB().select().from(paperlessConnections);
      expect(cleared!.billSource).toBeNull();
      expect(cleared!.fieldMapping).toBeNull();
    });

    it("round-trips bytea byte for byte", async () => {
      const user = await createTestUser();
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const [created] = await getDB()
        .insert(institutions)
        .values({
          userId: user.id,
          name: "Logo",
          logo: bytes,
          logoMime: "image/png",
          logoVersion: "1",
        })
        .returning({ id: institutions.id });
      const [row] = await getDB()
        .select({ logo: institutions.logo })
        .from(institutions)
        .where(eq(institutions.id, created!.id));
      expect(Buffer.isBuffer(row!.logo)).toBe(true);
      expect(row!.logo!.equals(bytes)).toBe(true);
      const empty = Buffer.alloc(0);
      await getDB()
        .update(institutions)
        .set({ logo: empty })
        .where(eq(institutions.id, created!.id));
      const [after] = await getDB().select().from(institutions);
      expect(after!.logo!.length).toBe(0);
    });

    it("round-trips timestamps to the millisecond and fills defaults", async () => {
      const user = await createTestUser();
      const at = new Date(1_700_000_123_456);
      const [created] = await getDB()
        .insert(institutions)
        .values({ userId: user.id, name: "T", createdAt: at, updatedAt: at })
        .returning({ id: institutions.id, createdAt: institutions.createdAt });
      expect(created!.createdAt.getTime()).toBe(1_700_000_123_456);
      const [row] = await getDB()
        .select({ createdAt: institutions.createdAt })
        .from(institutions)
        .where(eq(institutions.id, created!.id));
      expect(row!.createdAt.getTime()).toBe(1_700_000_123_456);

      const before = Date.now();
      const [fresh] = await getDB()
        .insert(institutions)
        .values({ userId: user.id, name: "Default" })
        .returning({ createdAt: institutions.createdAt });
      expect(fresh!.createdAt).toBeInstanceOf(Date);
      expect(Math.abs(fresh!.createdAt.getTime() - before)).toBeLessThan(5000);
      const [stored] = (await raw.unsafe(
        "select pg_typeof(created_at)::text as t from institutions limit 1",
      )) as { t: string }[];
      expect(stored!.t).toBe("timestamp with time zone");
    });

    it("keeps amounts above 2^31 exact and returns aggregates as numbers", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      const big = 2 ** 40;
      const huge = Number.MAX_SAFE_INTEGER - 10;
      for (const [i, amount] of [big, -big, huge, 1].entries()) {
        await createManualTransaction(user.id, account.id, {
          bookingDate: "2024-03-01",
          valueDate: null,
          amount: minor(amount),
          counterpartyName: null,
          counterpartyIban: null,
          description: `row ${i}`,
          reference: null,
          note: null,
        });
      }
      const rows = await getDB()
        .select({
          amount: transactions.amount,
          seq: transactions.seq,
        })
        .from(transactions)
        .orderBy(transactions.seq);
      expect(rows.map((r) => r.amount)).toEqual([big, -big, huge, 1]);
      expect(rows.every((r) => typeof r.amount === "number")).toBe(true);
      // seq is a microsecond clock: well above 2^31, still an exact number.
      expect(rows[0]!.seq).toBeGreaterThan(2 ** 50);

      const [agg] = await getDB()
        .select({
          n: count(),
          total: sql<number>`sum(${transactions.amount})`.mapWith(Number),
        })
        .from(transactions);
      expect(typeof agg!.n).toBe("number");
      expect(agg!.n).toBe(4);
      expect(agg!.total).toBe(huge + 1);
    });
  });

  describe("domain smoke", () => {
    beforeEach(() => start());

    const tx = (over: Record<string, unknown> = {}) => ({
      bookingDate: "2024-03-01",
      valueDate: null,
      amount: minor(-500),
      counterpartyName: null,
      counterpartyIban: null,
      description: null,
      reference: null,
      note: null,
      ...over,
    });

    it("creates a user, an account and transactions, then lists and balances them", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id, {
        openingBalance: minor(10_000),
      });
      await createManualTransaction(
        user.id,
        account.id,
        tx({ amount: minor(-2_500), description: "Coffee beans" }),
      );
      await createManualTransaction(
        user.id,
        account.id,
        tx({ amount: minor(1_000), description: "Refund" }),
      );

      const page = await listTransactions(user.id, account.id);
      expect(page.total).toBe(2);
      expect(page.items.map((t) => t.description).sort()).toEqual([
        "Coffee beans",
        "Refund",
      ]);
      expect(typeof page.items[0]!.createdAt).toBe("number");
      expect(await currentBalance(user.id, account.id, "2024-12-31")).toBe(
        8_500,
      );
      const accountsList = await listAccounts(user.id);
      expect(accountsList).toHaveLength(1);
      expect(accountsList[0]!.balance).toBe(8_500);
    });

    it("never over-allocates a payment to two bills when automatic matching races a manual allocation", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      await seedBill(user.id, {
        creditorIban: EXAMPLE_IBAN_OTHER,
        reference: EXAMPLE_QRR,
        referenceType: "QRR",
        issueDate: "2026-09-01",
        dueDate: "2026-10-01",
      });
      const other = await seedBill(user.id, { creditorIban: EXAMPLE_IBAN });
      const payment = await seedImportedTransaction(user.id, account.id, {
        amount: minor(-10_000),
        bookingDate: "2026-09-10",
        reference: EXAMPLE_QRR,
      });
      // The manual allocation is still uncommitted while automatic matching
      // runs: without the shared per-user lock both would pass their checks.
      const manual = transaction(
        async (tx) => {
          await allocateInTx(
            tx,
            user.id,
            other.id,
            payment.id,
            minor(10_000),
            "user",
          );
          await sleep(600);
        },
        { lock: `bills:${user.id}` },
      );
      await sleep(150);
      await Promise.all([manual, runAutoMatching(user.id)]);
      const rows = await getDB()
        .select({ id: billAllocations.id })
        .from(billAllocations)
        .where(eq(billAllocations.transactionId, payment.id));
      expect(rows).toHaveLength(1);
    });

    it("blocks a bill update while an allocation holds the user's bills lock", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      const bill = await seedBill(user.id, { creditorIban: EXAMPLE_IBAN });
      const payment = await seedImportedTransaction(user.id, account.id, {
        amount: minor(-10_000),
        bookingDate: "2026-09-10",
      });
      const manual = transaction(
        async (tx) => {
          await allocateInTx(
            tx,
            user.id,
            bill.id,
            payment.id,
            minor(10_000),
            "user",
          );
          await sleep(500);
        },
        { lock: `bills:${user.id}` },
      );
      await sleep(150);
      const outcome = await updateBill(user.id, bill.id, {
        ...billInput({ creditorIban: EXAMPLE_IBAN }),
        kind: "credit_note",
      }).then(
        () => null,
        (e: unknown) => e,
      );
      await manual;
      expect(outcome).toMatchObject({ code: "conflict", field: "kind" });
    });

    it("lists newest first, breaking ties on insertion order", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      for (const label of ["first", "second", "third"]) {
        await createManualTransaction(
          user.id,
          account.id,
          tx({ description: label }),
        );
      }
      await createManualTransaction(
        user.id,
        account.id,
        tx({ description: "older", bookingDate: "2024-02-01" }),
      );
      const page = await listTransactions(user.id, account.id);
      expect(page.items.map((t) => t.description)).toEqual([
        "third",
        "second",
        "first",
        "older",
      ]);
    });

    it("searches case-insensitively and takes % and _ literally", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      const make = (description: string) =>
        createManualTransaction(user.id, account.id, tx({ description }));
      await make("Grocery Store");
      await make("100% organic");
      await make("100 organic");
      await make("a_b");
      await make("axb");
      const search = async (q: string) =>
        (await listTransactions(user.id, account.id, { filters: { q } })).items
          .map((t) => t.description)
          .sort();
      expect(await search("GROCERY")).toEqual(["Grocery Store"]);
      expect(await search("0% o")).toEqual(["100% organic"]);
      expect(await search("a_b")).toEqual(["a_b"]);
    });

    it("reads the last import time as a number", async () => {
      const user = await createTestUser();
      const account = await seedAccount(user.id);
      expect((await listAccounts(user.id))[0]!.lastImportAt).toBeNull();
      const imported = await seedImport(user.id, account.id);
      const [view] = await listAccounts(user.id);
      expect(typeof view!.lastImportAt).toBe("number");
      expect(view!.lastImportAt).toBe(imported.createdAt.getTime());
    });

    it("hides another user's accounts and transactions", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const account = await seedAccount(alice.id);
      await createManualTransaction(alice.id, account.id, tx());
      expect(await listAccounts(bob.id)).toEqual([]);
      await expect(listTransactions(bob.id, account.id)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(
        (
          await getDB()
            .select({ n: count() })
            .from(transactions)
            .where(and(eq(transactions.userId, bob.id)))
        )[0]!.n,
      ).toBe(0);
    });
  });
});
