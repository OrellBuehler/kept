import { useTestStore } from "$lib/testing/store";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAutoMatching } from "$lib/server/bills/suggestions";
import { eq } from "drizzle-orm";
import { accounts } from "$lib/server/db";
import { getDB, inboxFiles, transactions } from "$lib/server/db";
import { saveCsvProfile } from "$lib/server/imports";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { IBAN_DE } from "$lib/testing/fixtures/values";
import { buildCamt } from "$lib/testing/fixtures/camt053/build";
import { fixture } from "$lib/testing/fixtures";
import { SIMPLE_CSV_PROFILE } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import {
  getInboxView,
  listInboxEntries,
  readInboxConfig,
  scanInbox,
  startInboxReview,
  type InboxConfig,
} from "./inbox";

vi.mock("$lib/server/bills/suggestions", async (orig) => {
  const actual = await orig<typeof import("$lib/server/bills/suggestions")>();
  return { ...actual, runAutoMatching: vi.fn(actual.runAutoMatching) };
});

// Runs after the n-th buildPreview call (the inbox previews once, confirm rebuilds it).
let afterPreview: { skip: number; run: () => Promise<void> } | null = null;
vi.mock("$lib/server/imports/preview", async (orig) => {
  const actual = await orig<typeof import("$lib/server/imports/preview")>();
  return {
    ...actual,
    buildPreview: async (...args: Parameters<typeof actual.buildPreview>) => {
      const preview = await actual.buildPreview(...args);
      if (afterPreview && afterPreview.skip-- <= 0) {
        const { run } = afterPreview;
        afterPreview = null;
        await run();
      }
      return preview;
    },
  };
});

useTestDB();
const blobs = useTestStore();

let config: InboxConfig;
beforeEach(() => {
  config = {
    dir: mkdtempSync(join(tmpdir(), "kept-inbox-")),
    intervalSeconds: 60,
  };
});
afterEach(() => {
  afterPreview = null;
  rmSync(config.dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);
const scan = (settleMs = 10_000) => scanInbox(config, { now: NOW, settleMs });

function drop(
  username: string,
  name: string,
  bytes: Uint8Array,
  folder?: string,
  ageMs = 60_000,
) {
  const dir = folder
    ? join(config.dir, username, folder)
    : join(config.dir, username);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const t = new Date(NOW - ageMs);
  utimesSync(path, t, t);
  return path;
}

const names = (user: string, folder: string) => {
  const dir = join(config.dir, user, folder);
  return existsSync(dir) ? readdirSync(dir) : [];
};

async function setup() {
  const user = await createTestUser({ username: "alice" });
  const account = await seedAccount(user.id, {
    name: "Main",
    iban: EXAMPLE_IBAN,
  });
  return { user, account };
}

const count = async (accountId: string) =>
  (
    await getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
  ).length;

describe("readInboxConfig", () => {
  it("is off without KEPT_INBOX_DIR and validates the interval", () => {
    expect(readInboxConfig({})).toBeNull();
    expect(readInboxConfig({ KEPT_INBOX_DIR: "/data/inbox" })).toEqual({
      dir: "/data/inbox",
      intervalSeconds: 60,
    });
    expect(() =>
      readInboxConfig({ KEPT_INBOX_DIR: "/x", KEPT_INBOX_INTERVAL: "1" }),
    ).toThrow(/Invalid inbox configuration/);
  });
});

describe("scanInbox", () => {
  it("imports a camt file whose IBAN matches an account and moves it to processed", async () => {
    const { user, account } = await setup();
    drop("alice", "stmt.xml", fixture("camt053/overlap-a.xml"));
    const summary = await scan();
    expect(summary).toMatchObject({ imported: 1, failed: 0, review: 0 });
    expect(await count(account.id)).toBe(5);
    expect(names("alice", "processed")).toHaveLength(1);
    expect(names("alice", "processed")[0]).toMatch(/stmt\.xml$/);
    expect(readdirSync(join(config.dir, "alice")).sort()).toEqual([
      "processed",
    ]);
    expect((await listInboxEntries(user.id))[0]).toMatchObject({
      status: "imported",
      accountName: "Main",
      newCount: 5,
    });
    // The handoff through the store leaves nothing behind.
    const left: string[] = [];
    for await (const b of blobs.store.list("pending-imports/"))
      left.push(b.key);
    expect(left).toEqual([]);
  });

  it("runs bill auto-matching after an imported file, and a matching failure does not fail the import", async () => {
    const { user, account } = await setup();
    vi.mocked(runAutoMatching).mockClear();
    vi.mocked(runAutoMatching).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    drop("alice", "stmt.xml", fixture("camt053/overlap-a.xml"));
    const summary = await scan();
    expect(summary).toMatchObject({ imported: 1, failed: 0 });
    expect(await count(account.id)).toBe(5);
    expect(runAutoMatching).toHaveBeenCalledTimes(1);
    expect(runAutoMatching).toHaveBeenCalledWith(user.id);
  });

  it("does not run bill auto-matching when nothing was imported", async () => {
    await setup();
    vi.mocked(runAutoMatching).mockClear();
    drop("alice", "notes.txt", new TextEncoder().encode("hello"));
    await scan();
    expect(runAutoMatching).not.toHaveBeenCalled();
  });

  it("mirrors transfers from an inbox import onto an account filled from transfers", async () => {
    const { user, account } = await setup();
    const savings = await seedAccount(user.id, {
      name: "Savings",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    drop(
      "alice",
      "transfer.xml",
      buildCamt({
        iban: EXAMPLE_IBAN,
        entries: [
          {
            date: "2024-07-01",
            amount: "10.00",
            sign: "DBIT",
            ref: "T1",
            counterpartyIban: EXAMPLE_IBAN_OTHER,
          },
        ],
      }),
    );
    expect(await scan()).toMatchObject({ imported: 1 });
    expect(await count(account.id)).toBe(1);
    const mirrors = await getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, savings.id));
    expect(mirrors).toEqual([
      expect.objectContaining({ source: "mirror", amount: 1000 }),
    ]);
  });

  it("fails a camt file with an unknown IBAN and writes a reason file", async () => {
    const { user, account } = await setup();
    drop(
      "alice",
      "other.xml",
      buildCamt({
        iban: IBAN_DE,
        entries: [
          { date: "2024-07-01", amount: "1.00", sign: "CRDT", ref: "X1" },
        ],
      }),
    );
    expect(await scan()).toMatchObject({ failed: 1, imported: 0 });
    expect(await count(account.id)).toBe(0);
    const failed = names("alice", "failed");
    expect(failed).toHaveLength(2);
    const reasonFile = failed.find((f) => f.endsWith(".reason.txt"))!;
    const reason = readFileSync(
      join(config.dir, "alice", "failed", reasonFile),
      "utf8",
    );
    expect(reason).toMatch(/No account of yours has the statement's IBAN/);
    expect(reason).not.toContain(IBAN_DE);
    expect((await listInboxEntries(user.id))[0]).toMatchObject({
      status: "failed",
    });
  });

  it("imports a csv in an account folder using the saved profile", async () => {
    const { user, account } = await setup();
    await saveCsvProfile(user.id, account.id, "Simple", SIMPLE_CSV_PROFILE);
    drop("alice", "export.csv", fixture("csv/overlap-a.csv"), "main");
    const summary = await scan();
    expect(summary.imported).toBe(1);
    expect(await count(account.id)).toBeGreaterThan(0);
    expect(names("alice", "processed")).toHaveLength(1);
  });

  it("leaves a csv without a profile for review and the user can continue it", async () => {
    const { user, account } = await setup();
    drop("alice", "export.csv", fixture("csv/overlap-a.csv"), "Main");
    expect(await scan()).toMatchObject({ review: 1, imported: 0 });
    expect(await count(account.id)).toBe(0);
    expect(names("alice", "review")).toHaveLength(1);
    const [entry] = await listInboxEntries(user.id);
    expect(entry).toMatchObject({ status: "review" });
    const target = await startInboxReview(config, user, entry!.id);
    expect(target).toMatch(/^\/import\/[\w-]+\/mapping$/);
    expect(
      (await getInboxView(user.id, user.username, config)).entries,
    ).toHaveLength(1);
  });

  it("does not show or let another user review an entry", async () => {
    const { user } = await setup();
    const other = await createTestUser();
    drop("alice", "export.csv", fixture("csv/overlap-a.csv"), "Main");
    await scan();
    const [entry] = await listInboxEntries(user.id);
    expect(await listInboxEntries(other.id)).toEqual([]);
    expect(
      (await getInboxView(other.id, other.username, config)).entries,
    ).toEqual([]);
    await expect(startInboxReview(config, other, entry!.id)).rejects.toThrow(
      /no longer waiting/,
    );
  });

  it("fails csv in the root and in a folder matching no account", async () => {
    await setup();
    drop("alice", "a.csv", fixture("csv/overlap-a.csv"));
    drop("alice", "b.csv", fixture("csv/overlap-b.csv"), "nonexistent");
    expect(await scan()).toMatchObject({ failed: 2 });
  });

  it("does not process the same file twice", async () => {
    const { account } = await setup();
    drop("alice", "one.xml", fixture("camt053/overlap-a.xml"));
    await scan();
    drop("alice", "copy.xml", fixture("camt053/overlap-a.xml"));
    const summary = await scan();
    expect(summary).toMatchObject({ duplicate: 1, imported: 0 });
    expect(await count(account.id)).toBe(5);
    expect(names("alice", "processed")).toHaveLength(2);
    expect(await getDB().select().from(inboxFiles)).toHaveLength(1);
  });

  it("skips files that are still being written", async () => {
    const { account } = await setup();
    const path = drop(
      "alice",
      "growing.xml",
      fixture("camt053/overlap-a.xml"),
      undefined,
      2_000,
    );
    expect(await scan()).toMatchObject({ skipped: 1, imported: 0 });
    expect(existsSync(path)).toBe(true);
    expect(await count(account.id)).toBe(0);
    const t = new Date(NOW - 60_000);
    utimesSync(path, t, t);
    expect(await scan()).toMatchObject({ imported: 1 });
    expect(existsSync(path)).toBe(false);
  });

  it("ignores partial-download names and unsupported extensions", async () => {
    await setup();
    drop("alice", "x.xml.part", fixture("camt053/overlap-a.xml"));
    drop("alice", ".hidden.xml", fixture("camt053/overlap-a.xml"));
    drop("alice", "notes.pdf", new Uint8Array([1, 2, 3]));
    expect(await scan()).toMatchObject({
      imported: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it("imports overlapping statements without duplicating transactions", async () => {
    const { account } = await setup();
    drop("alice", "a.xml", fixture("camt053/overlap-a.xml"));
    await scan();
    drop("alice", "b.xml", fixture("camt053/overlap-b.xml"));
    const summary = await scan();
    // Either imported cleanly or held back for review because of balance
    // warnings; in both cases no transaction exists twice.
    expect(summary.imported + summary.review).toBe(1);
    const rows = await getDB()
      .select({ id: transactions.externalId })
      .from(transactions)
      .where(eq(transactions.accountId, account.id));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("holds back a file whose preview has warnings instead of importing it", async () => {
    const { account } = await setup();
    drop(
      "alice",
      "first.xml",
      buildCamt({
        iban: EXAMPLE_IBAN,
        opening: { amount: "100.00", date: "2024-07-01" },
        closing: { amount: "110.00", date: "2024-07-05" },
        entries: [
          { date: "2024-07-02", amount: "10.00", sign: "CRDT", ref: "R1" },
        ],
      }),
    );
    await scan();
    drop(
      "alice",
      "gap.xml",
      buildCamt({
        iban: EXAMPLE_IBAN,
        opening: { amount: "500.00", date: "2024-08-01" },
        closing: { amount: "510.00", date: "2024-08-05" },
        entries: [
          { date: "2024-08-02", amount: "10.00", sign: "CRDT", ref: "R2" },
        ],
      }),
    );
    expect(await scan()).toMatchObject({ review: 1, imported: 0 });
    expect(await count(account.id)).toBe(1);
    expect(names("alice", "review")).toHaveLength(1);
  });

  it("leaves a file in place for the next scan when the account changed after the preview", async () => {
    const { account } = await setup();
    drop("alice", "stmt.xml", fixture("camt053/overlap-a.xml"));
    afterPreview = {
      skip: 1,
      run: async () => {
        await getDB()
          .update(accounts)
          .set({ currency: "EUR" })
          .where(eq(accounts.id, account.id));
      },
    };
    expect(await scan()).toMatchObject({ skipped: 1, failed: 0, imported: 0 });
    expect(names("alice", "failed")).toEqual([]);
    expect(readdirSync(join(config.dir, "alice"))).toContain("stmt.xml");
    expect(await count(account.id)).toBe(0);
  });

  it("moves a file to failed when trades move cash on the account", async () => {
    const { account } = await setup();
    await getDB()
      .update(accounts)
      .set({ tradesMoveCash: true })
      .where(eq(accounts.id, account.id));
    drop("alice", "stmt.xml", fixture("camt053/overlap-a.xml"));
    expect(await scan()).toMatchObject({ failed: 1, imported: 0 });
    expect(names("alice", "failed").length).toBeGreaterThan(0);
    expect(await count(account.id)).toBe(0);
  });

  it("only looks at the folder of each user", async () => {
    await setup();
    const bob = await createTestUser({ username: "bob" });
    const bobAccount = await seedAccount(bob.id, {
      name: "Bob",
      iban: EXAMPLE_IBAN,
    });
    drop("bob", "stmt.xml", fixture("camt053/overlap-a.xml"));
    await scan();
    expect(await count(bobAccount.id)).toBe(5);
    expect(names("alice", "processed")).toHaveLength(0);
  });
});
