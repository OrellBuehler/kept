import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { openDatabase, type DB } from "./db";
import { categoryRules, taxCredits, trades, transactions } from "./schema";

const SEQ_MIGRATION = "0029_strong_scourge";
const real = join(process.cwd(), "drizzle");

interface Journal {
  entries: { tag: string }[];
}

describe("seq migration", () => {
  let scratch: string;
  let db: DB;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "kept-migrations-"));
    cpSync(real, scratch, { recursive: true });
    const path = join(scratch, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
    const at = journal.entries.findIndex((e) => e.tag === SEQ_MIGRATION);
    expect(at).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, at);
    writeFileSync(path, JSON.stringify(journal));
    db = openDatabase(":memory:");
    // The rows below only need to exist; their parents are not under test.
    db.$client.exec("PRAGMA foreign_keys = OFF;");
    migrate(db, { migrationsFolder: scratch });
  });

  afterEach(() => {
    db.$client.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps the existing row order and puts new rows after it", async () => {
    // Ids are the reverse of insertion order, so ordering by id would flip it.
    const ids = ["z", "m", "a"];
    for (const id of ids) {
      db.$client.exec(
        `INSERT INTO transactions (id, user_id, account_id, source, external_id, booking_date, amount, currency)
         VALUES ('${id}', 'u', 'acc', 'manual', 'ext-${id}', '2030-01-01', 100, 'CHF')`,
      );
      db.$client.exec(
        `INSERT INTO category_rules (id, user_id, category_id) VALUES ('${id}', 'u', 'cat')`,
      );
      db.$client.exec(
        `INSERT INTO tax_credits (id, user_id, tax_year_id, booking_date, amount)
         VALUES ('${id}', 'u', 'year', '2030-01-01', 100)`,
      );
      db.$client.exec(
        `INSERT INTO trades (id, user_id, account_id, security_id, date, side, quantity, price, amount)
         VALUES ('${id}', 'u', 'acc', 'sec', '2030-01-01', 'buy', 100000000, 100000000, 100)`,
      );
    }
    // A gap in the rowids (deleted row) must not matter either.
    db.$client.exec(`DELETE FROM transactions WHERE id = 'm'`);
    db.$client.exec(
      `INSERT INTO transactions (id, user_id, account_id, source, external_id, booking_date, amount, currency)
       VALUES ('b', 'u', 'acc', 'manual', 'ext-b', '2030-01-01', 100, 'CHF')`,
    );

    migrate(db, { migrationsFolder: real });

    const order = <T extends { id: string }>(rows: T[]) =>
      rows.map((r) => r.id);
    expect(
      order(
        await db
          .select({ id: transactions.id })
          .from(transactions)
          .orderBy(asc(transactions.seq), asc(transactions.id)),
      ),
    ).toEqual(["z", "a", "b"]);
    for (const table of [categoryRules, taxCredits, trades]) {
      expect(
        order(
          await db
            .select({ id: table.id })
            .from(table)
            .orderBy(asc(table.seq), asc(table.id)),
        ),
      ).toEqual(ids);
    }

    await db.insert(transactions).values({
      id: "0",
      userId: "u",
      accountId: "acc",
      source: "manual",
      externalId: "ext-0",
      bookingDate: "2030-01-01",
      amount: 100 as never,
      currency: "CHF",
    });
    const all = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, "u"))
      .orderBy(asc(transactions.seq), asc(transactions.id));
    expect(order(all)).toEqual(["z", "a", "b", "0"]);
  });
});
