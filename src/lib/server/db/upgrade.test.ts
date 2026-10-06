import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { minor } from "$lib/money";
import { authenticate } from "$lib/server/auth/login";
import { validateSessionToken } from "$lib/server/auth/sessions";
import { billViews } from "$lib/server/bills/status";
import { readDocument } from "$lib/server/bills/documents";
import { decryptSecret } from "$lib/server/crypto";
import {
  listTransactionDtos,
  transactionsQuery,
} from "$lib/server/external-api/transactions";
import {
  listAccounts,
  listTransactions,
  readInstitutionLogo,
} from "$lib/server/ledger";
import { getChannelConfig, mayUseEmail } from "$lib/server/notifications/store";
import { getPreferences } from "$lib/server/preferences";
import { IBAN_CH } from "$lib/testing/fixtures/values";
import { createStore, setStore } from "$lib/server/storage";
import {
  countDeductionYearMoves,
  undoDeductionYearMoves,
} from "$lib/server/tax/deduction-year-migration";
import { deductionSummary } from "$lib/server/tax/deductions";
import { listTaxYears, paymentLines, reconcileYear } from "$lib/server/tax/tax";
import {
  compareUpgrade,
  diffSnapshots,
  encodeCell,
  takeSnapshot,
  type Snapshot,
} from "../../../../scripts/upgrade/lib";
import * as v030 from "$lib/testing/fixtures/upgrade/0.3.0/fixture";
import { dialect } from "./dialect";
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  setDB,
  withExclusiveClient,
  type DB,
} from "./index";

/**
 * The upgrade from a published 0.3.0 database to this version, on synthetic data.
 *
 * SQLite only, for two reasons. The 0.4.0 migrations 0017 to 0031 are SQLite migrations that an
 * existing install runs on first start; PostgreSQL support arrived in 0.4.0, so
 * `drizzle/postgres/` starts with a baseline of the final schema and there is no earlier
 * PostgreSQL release to upgrade from (`postgres.pg.test.ts` covers its migrations). And the
 * database is built by the sync migrator on a raw connection the way the 0.3.0 server did it.
 *
 * The same dataset, oracle and comparison run against the published image in
 * `scripts/upgrade/run.ts` (CI: `.github/workflows/docker.yml`).
 */

const real = join(process.cwd(), "drizzle", "sqlite");
const seedSql = readFileSync(
  join(
    process.cwd(),
    "src",
    "lib",
    "testing",
    "fixtures",
    "upgrade",
    "0.3.0",
    "seed.sql",
  ),
  "utf8",
);

interface Journal {
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
}

const readJournal = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as Journal;
const writeJournal = (dir: string, journal: Journal) =>
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));

/** A copy of the migration folder as of 0.3.0: the journal stops at its last migration. */
function releaseFolder(root: string): string {
  const dir = join(root, "migrations-0.3.0");
  cpSync(real, dir, { recursive: true });
  const journal = readJournal(dir);
  const last = journal.entries.findIndex((e) => e.tag === v030.lastMigration);
  expect(last).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, last + 1);
  writeJournal(dir, journal);
  return dir;
}

const minorsOnly = (snapshot: Snapshot, table: string, column: string) =>
  snapshot.tables[table].rows.map((r) => r[column]);

describe.skipIf(dialect === "pg")("upgrade from 0.3.0", () => {
  let root: string;
  let path: string;
  let before: Snapshot;
  let db: DB | null = null;
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.KEPT_SECRET_KEY;
    process.env.KEPT_SECRET_KEY = v030.secretKey;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.KEPT_SECRET_KEY;
    else process.env.KEPT_SECRET_KEY = savedKey;
  });

  /** Builds the database a 0.3.0 server leaves behind: its migrations, then the seed. */
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kept-upgrade-"));
    path = join(root, "data", "kept.db");
    mkdirSync(dirname(path), { recursive: true });
    const client = new Database(path, { create: true, strict: true });
    client.exec("PRAGMA journal_mode = WAL;");
    client.exec("PRAGMA foreign_keys = ON;");
    migrate(drizzle({ client }), { migrationsFolder: releaseFolder(root) });
    client.exec(seedSql);
    before = takeSnapshot(client);
    client.close();
    for (const file of v030.files) {
      const target = join(root, "data", file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
  });

  afterEach(async () => {
    if (db) await closeDatabase(db);
    db = null;
    setDB(null);
    setStore(null);
    rmSync(root, { recursive: true, force: true });
  });

  /** What `init()` in hooks.server.ts does: open the file, run the migrations. */
  async function startServer(): Promise<DB> {
    db = openDatabase(path);
    setDB(db);
    setStore(createStore({ kind: "fs", dir: join(root, "data") }));
    await runMigrations();
    return db;
  }
  const snapshot = () =>
    withExclusiveClient((client) => takeSnapshot(client), db!);
  const stopServer = async () => {
    await closeDatabase(db!);
    db = null;
    setDB(null);
  };

  describe("the starting point", () => {
    it("is a 0.3.0 database holding data in every table", () => {
      expect(before.migrations).toHaveLength(17);
      expect(Object.keys(before.tables)).not.toContain("trades");
      expect(Object.keys(before.tables)).toHaveLength(35);
      for (const [table, count] of Object.entries(v030.rowCounts)) {
        expect(before.tables[table].rows, table).toHaveLength(count);
      }
      expect(Object.keys(v030.rowCounts).sort()).toEqual(
        Object.keys(before.tables).sort(),
      );
      expect(before.integrityCheck).toEqual(["ok"]);
      expect(before.foreignKeyViolations).toEqual([]);
    });

    it("uses the migrations of the 0.3.0 release", () => {
      const tags = readJournal(releaseFolder(root)).entries.map((e) => e.tag);
      expect(tags).toHaveLength(17);
      expect(tags.at(-1)).toBe(v030.lastMigration);
      const full = readJournal(real).entries.map((e) => e.tag);
      expect(full[17]).toBe(v030.firstUpgradeMigration);
    });
  });

  describe("migrations 0017 to the latest, applied the way the server applies them at start", () => {
    it("loses and changes nothing but what the migrations rewrite on purpose", async () => {
      await startServer();
      const after = await snapshot();
      expect(compareUpgrade(before, after, v030.expected)).toEqual([]);
      expect(after.migrations).toHaveLength(readJournal(real).entries.length);
    });

    it("keeps every row count of the old tables", async () => {
      await startServer();
      const after = await snapshot();
      for (const [table, count] of Object.entries(v030.rowCounts)) {
        expect(after.tables[table].rows, table).toHaveLength(count);
      }
    });

    it("passes SQLite's integrity and foreign key checks", async () => {
      await startServer();
      const after = await snapshot();
      expect(after.integrityCheck).toEqual(["ok"]);
      expect(after.foreignKeyViolations).toEqual([]);
    });

    it("keeps money as integer minor units with the currency beside it", async () => {
      await startServer();
      const after = await snapshot();
      const money: [string, string][] = [
        ["accounts", "opening_balance"],
        ["balance_snapshots", "amount"],
        ["bill_allocations", "amount"],
        ["bills", "amount"],
        ["budgets", "amount"],
        ["imports", "opening_balance"],
        ["imports", "closing_balance"],
        ["planned_items", "amount"],
        ["recurring_series", "amount"],
        ["recurring_series", "last_amount"],
        ["tax_credits", "amount"],
        ["tax_years", "assessed_total"],
        ["transactions", "amount"],
        ["transactions", "original_amount"],
      ];
      for (const [table, column] of money) {
        for (const cell of minorsOnly(after, table, column)) {
          expect(
            cell === null || cell.startsWith("i:"),
            `${table}.${column}`,
          ).toBe(true);
        }
      }
      for (const table of [
        "accounts",
        "bills",
        "transactions",
        "budgets",
        "tax_years",
      ]) {
        for (const cell of minorsOnly(after, table, "currency")) {
          expect(cell).toMatch(/^t:[A-Z]{3}$/);
        }
      }
      const huge = after.tables.transactions.rows.find(
        (r) => r.id === "t:tx-a-13",
      );
      expect(huge?.amount).toBe(encodeCell(Number.MAX_SAFE_INTEGER));
    });

    it("keeps every row with the user that owned it", async () => {
      await startServer();
      const after = await snapshot();
      const owners = (s: Snapshot, table: string) =>
        Object.fromEntries(
          s.tables[table].rows.map((r) => [r.id ?? r.user_id, r.user_id]),
        );
      for (const [table, t] of Object.entries(before.tables)) {
        if (!t.columns.includes("user_id")) continue;
        expect(owners(after, table), table).toEqual(owners(before, table));
      }
    });

    it("keeps the unique indexes", async () => {
      await startServer();
      const after = await snapshot();
      expect(after.indexes).toEqual(expect.arrayContaining(before.indexes));
    });

    it("is not run again, and changes nothing, when the server starts again", async () => {
      await startServer();
      const first = await snapshot();
      await runMigrations();
      expect(diffSnapshots(first, await snapshot())).toEqual([]);
      await stopServer();
      await startServer();
      const third = await snapshot();
      expect(diffSnapshots(first, third)).toEqual([]);
      expect(third.migrations).toEqual(first.migrations);
    });

    it("leaves files next to the database where they were", async () => {
      await startServer();
      for (const file of v030.files) {
        const target = join(root, "data", file.path);
        expect(existsSync(target), file.path).toBe(true);
        expect(readFileSync(target, "utf8")).toBe(file.content);
      }
    });
  });

  describe("migration 0021: tax payments reclassified as deductions", () => {
    it("moves exactly the outflows of a deduction category that no tax-office line accounts for", async () => {
      await startServer();
      const after = await snapshot();
      const rows = new Map(
        after.tables.transactions.rows.map((r) => [r.id, r]),
      );
      for (const [id, year] of Object.entries(v030.movedToDeductionYear)) {
        const row = rows.get(`t:${id}`)!;
        expect(row.tax_year, id).toBeNull();
        expect(row.deduction_year, id).toBe(`i:${year}`);
      }
      for (const [id, year] of Object.entries(v030.keptAsTaxPayment)) {
        const row = rows.get(`t:${id}`)!;
        expect(row.tax_year, id).toBe(`i:${year}`);
        expect(row.deduction_year, id).toBeNull();
      }
      const tagged = after.tables.transactions.rows.filter(
        (r) => r.tax_year !== null || r.deduction_year !== null,
      );
      expect(tagged).toHaveLength(
        Object.keys(v030.movedToDeductionYear).length +
          Object.keys(v030.keptAsTaxPayment).length,
      );
    });

    it("records every move so it can be undone, and nothing else", async () => {
      await startServer();
      const after = await snapshot();
      const records = after.tables.deduction_year_migration.rows;
      expect(records).toHaveLength(
        Object.keys(v030.movedToDeductionYear).length,
      );
      const byTransaction = new Map(records.map((r) => [r.transaction_id, r]));
      for (const [id, year] of Object.entries(v030.movedToDeductionYear)) {
        const record = byTransaction.get(`t:${id}`)!;
        expect(record.old_tax_year, id).toBe(`i:${year}`);
        const owner = after.tables.transactions.rows.find(
          (r) => r.id === `t:${id}`,
        )!.user_id;
        expect(record.user_id, id).toBe(owner);
      }
    });

    it("leaves a moved row otherwise untouched, including its update time and flags", async () => {
      await startServer();
      const after = await snapshot();
      const was = new Map(
        before.tables.transactions.rows.map((r) => [r.id, r]),
      );
      const now = new Map(after.tables.transactions.rows.map((r) => [r.id, r]));
      const excluded = now.get("t:tx-a-x15")!;
      expect(excluded.deduction_excluded).toBe("i:1");
      expect(now.get("t:tx-a-x16")!.reversal).toBe("i:1");
      for (const id of Object.keys(v030.movedToDeductionYear)) {
        const a = was.get(`t:${id}`)!;
        const b = now.get(`t:${id}`)!;
        expect({
          ...b,
          tax_year: a.tax_year,
          deduction_year: null,
          seq: null,
        }).toEqual({
          ...a,
          deduction_year: null,
          seq: null,
          mirror_of_id: null,
        });
      }
    });

    it("counts the moves of one year per user, and undoing them restores the tax year", async () => {
      await startServer();
      expect(await countDeductionYearMoves("usr-alice", 2023)).toBe(5);
      expect(await countDeductionYearMoves("usr-alice", 2024)).toBe(2);
      expect(await countDeductionYearMoves("usr-bob", 2023)).toBe(1);
      expect(await countDeductionYearMoves("usr-carol", 2023)).toBe(0);

      expect(await undoDeductionYearMoves("usr-alice", 2023)).toBe(5);
      const after = await snapshot();
      const rows = new Map(
        after.tables.transactions.rows.map((r) => [r.id, r]),
      );
      for (const id of [
        "tx-a-x01",
        "tx-a-x02",
        "tx-a-x15",
        "tx-a-x21",
        "tx-a-x26",
      ]) {
        expect(rows.get(`t:${id}`)!.tax_year, id).toBe("i:2023");
        expect(rows.get(`t:${id}`)!.deduction_year, id).toBeNull();
      }
      // Another user's move and another year's moves are still there.
      expect(rows.get("t:tx-b-y01")!.deduction_year).toBe("i:2023");
      expect(rows.get("t:tx-a-x04")!.deduction_year).toBe("i:2024");
      expect(await countDeductionYearMoves("usr-alice", 2023)).toBe(0);
    });

    it("keeps the moved payments in the deductions of the year they were tagged for", async () => {
      await startServer();
      const donations = (await deductionSummary("usr-alice", 2023)).totals.find(
        (t) => t.type === "donations" && t.currency === "CHF",
      )!;
      // x01 (200.00), x15 is excluded, x21 (0.01), x26 (770.00), plus the ones that stay with
      // a tax-office line because 0.4.0 reads their year from the booking date: x12, x25.
      const ids = donations.lines.map((l) => l.transactionId).sort();
      expect(ids).toEqual(
        expect.arrayContaining(["tx-a-x01", "tx-a-x21", "tx-a-x26"]),
      );
      expect(ids).not.toContain("tx-a-x15");
      const moved = donations.lines.filter(
        (l) => v030.movedToDeductionYear[l.transactionId!],
      );
      expect(moved.every((l) => l.explicitYear)).toBe(true);
      expect(moved.reduce((sum, l) => sum + l.amount, 0)).toBe(
        20000 + 1 + 77000,
      );
      expect(
        (await deductionSummary("usr-alice", 2023)).excluded.map(
          (l) => l.transactionId,
        ),
      ).toEqual(["tx-a-x15"]);
    });

    it("reads the tax payments of a year without the moved ones", async () => {
      await startServer();
      const lines = await paymentLines("usr-alice", 2023);
      const ids = lines.map((l) => l.transactionId);
      for (const [id, year] of Object.entries(v030.keptAsTaxPayment)) {
        if (!id.startsWith("tx-a-") || year !== 2023) continue;
        // x09 and x14 and x10, x11: tagged, so they are tax payment lines
        expect(ids, id).toContain(id);
      }
      for (const [id, year] of Object.entries(v030.movedToDeductionYear)) {
        if (!id.startsWith("tx-a-") || year !== 2023) continue;
        expect(ids, id).not.toContain(id);
      }
      const reconciliation = (await reconcileYear("usr-alice", 2023))!;
      expect(reconciliation.year.assessedTotal).toBe(minor(1234500));
      // The tax office's lines of 2023 are all there, whatever they were paired with.
      expect(
        reconciliation.rows
          .flatMap((r) => (r.office ? [r.office.amount] : []))
          .sort((a, b) => a - b),
      ).toEqual([50000, 88800]);
      // Every payment line is on a row, none of the moved ones.
      expect(
        reconciliation.rows
          .flatMap((r) => (r.mine ? [r.mine.transactionId] : []))
          .sort(),
      ).toEqual(
        ids
          .filter(
            (id) =>
              lines.find((l) => l.transactionId === id)!.currency === "CHF",
          )
          .sort(),
      );
      const summaries = await listTaxYears("usr-alice");
      expect(summaries.map((s) => s.year)).toEqual([2024, 2023, 2022]);
    });

    it("does not let one user's tax-office lines decide another user's payments", async () => {
      await startServer();
      const after = await snapshot();
      const rows = new Map(
        after.tables.transactions.rows.map((r) => [r.id, r]),
      );
      // bob's 500.00 is moved although alice has a 500.00 line in the same year, and the reverse for 770.00
      expect(rows.get("t:tx-b-y01")!.deduction_year).toBe("i:2023");
      expect(rows.get("t:tx-a-x26")!.deduction_year).toBe("i:2023");
      expect(rows.get("t:tx-b-y03")!.tax_year).toBe("i:2023");
    });
  });

  describe("migration 0023: accounts archived before archived_at existed", () => {
    it("gives them their last update as the archive time and nobody else", async () => {
      await startServer();
      const after = await snapshot();
      const archived = after.tables.accounts.rows
        .filter((r) => r.archived_at !== null)
        .map((r) => [r.id, r.archived_at]);
      expect(Object.fromEntries(archived)).toEqual(
        Object.fromEntries(
          Object.entries(v030.archivedAccounts).map(([id, at]) => [
            `t:${id}`,
            `i:${at}`,
          ]),
        ),
      );
      const flagged = after.tables.accounts.rows.filter(
        (r) => r.archived === "i:1",
      );
      expect(flagged).toHaveLength(Object.keys(v030.archivedAccounts).length);
    });

    it("shows archived accounts as archived in the app, with the balance they had", async () => {
      await startServer();
      const accounts = await listAccounts("usr-alice", "2025-01-01");
      const savings = accounts.find((a) => a.id === "acc-a-sav")!;
      expect(savings.archived).toBe(true);
      expect(savings.balance).toBe(minor(101234));
      expect(accounts.find((a) => a.id === "acc-a-old")!.archived).toBe(true);
      expect(accounts.find((a) => a.id === "acc-a-chk")!.archived).toBe(false);
    });
  });

  describe("migration 0029: seq replaces rowid", () => {
    it("copies the rowid, gaps included, so the order of rows stays as it was", async () => {
      await startServer();
      const after = await snapshot();
      for (const table of ["transactions", "category_rules", "tax_credits"]) {
        const rows = after.tables[table].rows;
        for (const row of rows)
          expect(row.seq, `${table} ${row.id}`).toBe(row.__rowid);
        const seqs = rows.map((r) => Number(r.seq!.slice(2)));
        expect(seqs, table).toEqual([...seqs].sort((a, b) => a - b));
      }
      // The deleted rows left holes that are kept.
      const credits = after.tables.tax_credits.rows.map((r) =>
        Number(r.seq!.slice(2)),
      );
      expect(credits.at(-1)).toBe(7);
      expect(credits).not.toContain(2);
      expect(after.tables.trades.rows).toEqual([]);
    });

    it("lists transactions of the same day in the order they were entered", async () => {
      await startServer();
      const page = await listTransactions("usr-alice", "acc-a-chk", {
        pageSize: 200,
      });
      const ids = page.items.map((t) => t.id);
      // 2024-03-02 and 2024-03-03: tx-a-05 is newest; seq breaks ties within a day by insertion.
      expect(ids.indexOf("tx-a-05")).toBeLessThan(ids.indexOf("tx-a-04"));
    });
  });

  describe("what the app reads from the upgraded database", () => {
    it("shows the balance of every account", async () => {
      await startServer();
      const balances = Object.fromEntries(
        (await listAccounts("usr-alice", "2025-06-30")).map((a) => [
          a.id,
          a.balance,
        ]),
      );
      expect(balances).toEqual({
        // statement balance of 2024-06-30 less what was booked after it (x03, x04, x16, x17, x23)
        "acc-a-chk": minor(650000 - 700000 - 123456 - 4000 - 100 - 5000),
        "acc-a-sav": minor(101234),
        "acc-a-old": minor(5000),
        "acc-a-eur": minor(-1250),
        "acc-a-usd": minor(Number.MAX_SAFE_INTEGER),
        "acc-a-card": minor(-35000 - 8990 - 100),
      });
      const chk = (await listAccounts("usr-alice")).find(
        (a) => a.id === "acc-a-chk",
      )!;
      expect(chk.iban).toBe(IBAN_CH);
      expect(chk.openingBalance).toBe(minor(150000));
      expect(chk.institution?.name).toBe("Example Bank A");
      const eur = (await listAccounts("usr-alice")).find(
        (a) => a.id === "acc-a-eur",
      )!;
      expect(eur).toMatchObject({
        currency: "EUR",
        shareBps: 5000,
        sharedWith: "Household",
      });
      expect(eur.fillFromTransfers).toBe(false);
      expect(eur.tradesMoveCash).toBe(false);
      expect(eur.noticeMonths).toBeNull();
    });

    it("lists transactions with amounts, currencies and reversals as entered", async () => {
      await startServer();
      const eur = await listTransactions("usr-alice", "acc-a-eur", {
        pageSize: 200,
      });
      const foreign = eur.items.find((t) => t.id === "tx-a-10")!;
      expect(foreign).toMatchObject({
        amount: -45000,
        currency: "EUR",
        originalAmount: -49000,
        originalCurrency: "USD",
      });
      const chk = await listTransactions("usr-alice", "acc-a-chk", {
        pageSize: 200,
      });
      expect(chk.items.find((t) => t.id === "tx-a-05")).toMatchObject({
        amount: 4500,
        reversal: true,
      });
      const text = chk.items.find((t) => t.id === "tx-a-02")!;
      expect(text).toMatchObject({
        description: "Café Zürich – naïve ñ 日本 'quoted' \"double\"",
        note: "line one\nline two",
      });
      const hits = await listTransactions("usr-alice", "acc-a-chk", {
        filters: { q: "salary" },
      });
      expect(hits.total).toBe(1);
    });

    it("computes bill status from the allocations", async () => {
      await startServer();
      const views = new Map(
        (await billViews("usr-alice", { today: "2024-06-01" })).map((b) => [
          b.id,
          b,
        ]),
      );
      expect(views.get("bill-a1")).toMatchObject({
        status: "paid",
        settled: 25000,
        remaining: 0,
        documentId: "doc-a1",
        referenceType: "QRR",
        taxYear: 2023,
      });
      expect(views.get("bill-a4")).toMatchObject({
        status: "partially_paid",
        settled: 5000,
        remaining: 4999,
      });
      expect(views.get("bill-a3")).toMatchObject({
        status: "cancelled",
        externalSource: "paperless",
      });
      expect(views.get("bill-a3")!.extraction).toEqual({
        source: "text",
        warnings: ["amount guessed"],
      });
      expect(views.get("bill-a2")).toMatchObject({
        amount: null,
        status: "open",
      });
      expect(views.get("bill-a5")).toMatchObject({
        kind: "credit_note",
        status: "credit_due",
      });
    });

    it("serves the documents and logos stored before the upgrade", async () => {
      await startServer();
      const doc = await readDocument("usr-alice", "doc-a1");
      expect(Buffer.from(doc.bytes).toString("utf8")).toBe(
        v030.files[0].content,
      );
      const logo = await readInstitutionLogo("usr-alice", "inst-a1");
      expect(logo.mime).toBe("image/png");
      expect(Buffer.from(logo.bytes).subarray(0, 4).toString("hex")).toBe(
        "89504e47",
      );
    });

    it("serves the external API from rows written by 0.3.0", async () => {
      await startServer();
      const page = await listTransactionDtos(
        "usr-alice",
        null,
        transactionsQuery.parse({ accountId: "acc-a-eur", limit: "200" }),
        "http://localhost",
      );
      expect(
        page.items.map((t) => [t.id, t.amount, t.currency]).sort(),
      ).toEqual(
        [
          ["tx-a-10", -45000, "EUR"],
          ["tx-a-11", -9999, "EUR"],
          ["tx-a-12", 300000, "EUR"],
          ["tx-a-x14", -50000, "EUR"],
        ].sort(),
      );
      expect(page.items.find((t) => t.id === "tx-a-11")!.billIds).toEqual([
        "bill-a4",
      ]);
    });

    it("keeps preferences, sessions and passwords working", async () => {
      await startServer();
      expect(await getPreferences("usr-alice")).toMatchObject({
        ibanDisplay: "masked",
        blurAmounts: true,
        locale: "de-CH",
        defaultCurrency: "CHF",
        pageSize: 50,
        investmentCashLiquid: false,
      });
      const session = await validateSessionToken(v030.sessionCookies.alice);
      expect(session?.user).toMatchObject({
        id: "usr-alice",
        username: "alice",
        role: "admin",
      });
      expect(
        (await validateSessionToken(v030.sessionCookies.bob))?.user.role,
      ).toBe("member");

      const login = await authenticate("alice", v030.password, "203.0.113.7");
      expect(login).toMatchObject({ session: expect.anything() });
      expect(await authenticate("alice", "wrong", "203.0.113.8")).toBeNull();
    });

    it("decrypts the stored secrets with the key they were encrypted with", async () => {
      await startServer();
      const after = await snapshot();
      const cell = (table: string, id: string, column: string) =>
        after.tables[table].rows
          .find((r) => r.id === `t:${id}` || r.user_id === `t:${id}`)!
          [column]!.slice(2);
      expect(
        decryptSecret(
          cell("paperless_connections", "pc-a-1", "token_encrypted"),
        ),
      ).toBe("fixture-paperless-token");
      expect(
        decryptSecret(cell("totp_credentials", "usr-carol", "secret")),
      ).toBe("JBSWY3DPEHPK3PXP");
      expect(await getChannelConfig("usr-alice", "ntfy")).toEqual({
        serverUrl: "https://ntfy.example.invalid",
        topic: "kept-upgrade-alice",
      });
      expect(await getChannelConfig("usr-bob", "webhook")).toEqual({
        url: "https://hooks.example.invalid/kept",
        secret: "fixture-webhook-secret",
      });
    });

    it("keeps a member's email channel stored, but only administrators may use email", async () => {
      await startServer();
      expect(await getChannelConfig("usr-bob", "email")).toEqual({
        to: "bob@example.invalid",
      });
      expect(await mayUseEmail("usr-bob")).toBe(false);
      expect(await mayUseEmail("usr-alice")).toBe(true);
    });

    it("keeps one user's data out of another user's reads", async () => {
      await startServer();
      expect(await billViews("usr-bob", { today: "2024-06-01" })).toHaveLength(
        1,
      );
      expect((await listAccounts("usr-bob")).map((a) => a.id)).toEqual([
        "acc-b-chk",
        "acc-b-sav",
      ]);
      await expect(listTransactions("usr-bob", "acc-a-chk")).rejects.toThrow();
      await expect(readDocument("usr-bob", "doc-a1")).rejects.toThrow();
      await expect(readInstitutionLogo("usr-bob", "inst-a1")).rejects.toThrow();
      expect(await listTaxYears("usr-carol")).toEqual([]);
      expect(await countDeductionYearMoves("usr-carol", 2023)).toBe(0);
      const carol = await listTransactionDtos(
        "usr-carol",
        null,
        transactionsQuery.parse({ limit: "200" }),
        "http://localhost",
      );
      expect(carol.items.map((t) => t.id)).toEqual(["tx-c-01"]);
    });
  });

  describe("a migration that fails", () => {
    /** The real folder plus one migration that fails after `after`, or after the last one. */
    function withFailingMigration(after: string | null): string {
      const dir = join(root, "migrations-failing");
      cpSync(real, dir, { recursive: true });
      const journal = readJournal(dir);
      const at =
        after === null
          ? journal.entries.length - 1
          : journal.entries.findIndex((e) => e.tag === after);
      expect(at).toBeGreaterThan(0);
      const tag = "9999_fails_on_purpose";
      journal.entries.splice(at + 1, 0, {
        idx: 0,
        version: "6",
        when: journal.entries[at].when + 1,
        tag,
        breakpoints: true,
      });
      journal.entries.forEach((e, i) => (e.idx = i));
      writeJournal(dir, journal);
      writeFileSync(
        join(dir, `${tag}.sql`),
        "CREATE TABLE `survivor` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint\n" +
          "INSERT INTO `survivor` (`id`) VALUES ('x');--> statement-breakpoint\n" +
          "UPDATE `accounts` SET `name` = 'changed';--> statement-breakpoint\n" +
          "INSERT INTO `survivor` (`id`) VALUES ('x');\n",
      );
      return dir;
    }

    /** The migrator `migrateSqlite()` runs, on the folder given. */
    const migrateWith = (folder: string) =>
      withExclusiveClient(
        (client) => migrate(drizzle({ client }), { migrationsFolder: folder }),
        db!,
      );

    it.each([
      ["after the last migration, when everything before it has run", null],
      [
        "after the data migration 0021 and before the others",
        "0021_reclassify_deduction_years",
      ],
      ["after 0029, the last data migration", "0029_strong_scourge"],
    ])(
      "leaves the database as it was when one fails %s",
      async (_label, after) => {
        db = openDatabase(path);
        setDB(db);
        const folder = withFailingMigration(after);
        await expect(migrateWith(folder)).rejects.toThrow();

        const left = await snapshot();
        expect(diffSnapshots(before, left)).toEqual([]);
        expect(Object.keys(left.tables).sort()).toEqual(
          Object.keys(before.tables).sort(),
        );
        expect(left.indexes).toEqual(before.indexes);
        expect(left.migrations).toEqual(before.migrations);
        expect(
          compareUpgrade(before, left, {
            newTables: [],
            newColumns: {},
            newColumnValues: () => ({}),
            changes: {},
          }),
        ).toEqual([]);
      },
    );

    it("upgrades normally afterwards, once the cause is gone", async () => {
      db = openDatabase(path);
      setDB(db);
      await expect(migrateWith(withFailingMigration(null))).rejects.toThrow();
      await runMigrations();
      expect(compareUpgrade(before, await snapshot(), v030.expected)).toEqual(
        [],
      );
    });
  });
});
