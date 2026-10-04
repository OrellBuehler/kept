import { useTestStore } from "$lib/testing/store";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { balanceSnapshots, getDB, imports, transactions } from "$lib/server/db";
import { parseMappingProfile } from "$lib/server/importers/mapping";
import { accountBalanceAt, currentBalance } from "$lib/server/ledger/balances";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { buildCamt } from "$lib/testing/fixtures/camt053/build";
import {
  SIMPLE_CSV_PROFILE,
  uploadBytes,
  uploadFixture,
} from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { createCategory } from "$lib/server/categories/categories";
import { createRule } from "$lib/server/categories/rules";
import { confirmImport } from "./confirm";
import { listImports, listRecentImports, undoImport } from "./history";
import { pendingBlobKey, readPending } from "./pending";

useTestDB();
const ctx = useTestStore();

async function setup() {
  const user = await createTestUser();
  const account = await seedAccount(user.id, { iban: EXAMPLE_IBAN });
  return { user, account };
}

const txCount = (accountId: string) =>
  getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all().length;

describe("confirmImport", () => {
  it("writes the import, its transactions and a closing-balance snapshot", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    const r = await confirmImport(user.id, id);
    expect(r).toMatchObject({
      accountId: account.id,
      newCount: 5,
      duplicateCount: 0,
    });

    const imp = getDB()
      .select()
      .from(imports)
      .where(eq(imports.id, r.importId))
      .get()!;
    expect(imp).toMatchObject({
      userId: user.id,
      accountId: account.id,
      format: "camt053",
      fileName: "overlap-a.xml",
      statementFrom: "2024-07-01",
      statementTo: "2024-07-10",
      openingBalance: 100000,
      openingBalanceDate: "2024-07-01",
      closingBalance: 123250,
      closingBalanceDate: "2024-07-10",
      newCount: 5,
      duplicateCount: 0,
    });
    expect(imp.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(imp.warnings)).toEqual([]);

    const rows = getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all();
    expect(rows).toHaveLength(5);
    expect(
      rows.every(
        (t) =>
          t.source === "import" &&
          t.importId === r.importId &&
          t.userId === user.id,
      ),
    ).toBe(true);

    const snap = getDB()
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, account.id))
      .all();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      source: "import",
      date: "2024-07-10",
      amount: 123250,
      importId: r.importId,
    });
    expect(await currentBalance(user.id, account.id, "2024-07-31")).toBe(
      minor(123250),
    );
  });

  it("removes the pending upload afterwards and cannot be confirmed twice", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    await confirmImport(user.id, id);
    await expect(readPending(user.id, id)).rejects.toThrow(/not found/);
    expect(await ctx.store.has(pendingBlobKey(user.id, id))).toBe(false);
    await expect(confirmImport(user.id, id)).rejects.toThrow(/not found/);
    expect(txCount(account.id)).toBe(5);
  });

  it("two concurrent confirms of one upload import it once", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    const results = await Promise.allSettled([
      confirmImport(user.id, id),
      confirmImport(user.id, id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(txCount(account.id)).toBe(5);
    expect(getDB().select().from(imports).all()).toHaveLength(1);
  });

  it("importing the same file again adds nothing but is recorded", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const again = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    expect(again).toMatchObject({ newCount: 0, duplicateCount: 5 });
    expect(txCount(account.id)).toBe(5);
    expect(
      getDB()
        .select()
        .from(balanceSnapshots)
        .where(eq(balanceSnapshots.accountId, account.id))
        .all(),
    ).toHaveLength(1);
  });

  it("two overlapping files never duplicate rows", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const b = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-b.xml"),
    );
    expect(b).toMatchObject({ newCount: 2, duplicateCount: 3 });
    expect(txCount(account.id)).toBe(7);
    expect(await accountBalanceAt(user.id, account.id, "2024-07-15")).toBe(
      minor(118750),
    );
    const snaps = getDB()
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, account.id))
      .all();
    expect(snaps.map((s) => s.date).sort()).toEqual([
      "2024-07-10",
      "2024-07-15",
    ]);
  });

  it("re-imports overlapping csv files (hash ids) without duplicates", async () => {
    const { user, account } = await setup();
    const profile = parseMappingProfile(SIMPLE_CSV_PROFILE);
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
      { profile },
    );
    const b = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-b.csv"),
      { profile },
    );
    expect(b).toMatchObject({ newCount: 1, duplicateCount: 4 });
    expect(txCount(account.id)).toBe(6);
  });

  it("upserts the import snapshot for the same date instead of failing", async () => {
    const { user, account } = await setup();
    const make = (closing: string, ref: string) =>
      buildCamt({
        iban: EXAMPLE_IBAN,
        closing: { amount: closing, date: "2024-05-31" },
        entries: [{ date: "2024-05-02", amount: "1.00", sign: "CRDT", ref }],
      });
    const first = await confirmImport(
      user.id,
      await uploadBytes(user.id, account.id, make("10.00", "U1")),
    );
    const second = await confirmImport(
      user.id,
      await uploadBytes(user.id, account.id, make("12.00", "U2")),
    );
    const snaps = getDB()
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, account.id))
      .all();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ amount: 1200, importId: second.importId });
    expect(first.importId).not.toBe(second.importId);
  });

  it("refuses when the preview has errors and writes nothing", async () => {
    const { user, account } = await setup();
    const csv = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    await expect(confirmImport(user.id, csv)).rejects.toThrow(
      /mapping_required/,
    );
    const wrongCurrency = await uploadFixture(
      user.id,
      account.id,
      "camt053/v08-basic.xml",
    );
    await expect(confirmImport(user.id, wrongCurrency)).rejects.toThrow(
      /different IBAN/,
    );
    expect(txCount(account.id)).toBe(0);
    expect(getDB().select().from(imports).all()).toEqual([]);
    await expect(readPending(user.id, csv)).resolves.toBeDefined();
  });

  it("stores the preview warnings with the import", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "100.00", date: "2024-03-01" },
          closing: { amount: "150.00", date: "2024-03-31" },
          entries: [
            { date: "2024-03-10", amount: "50.00", sign: "CRDT", ref: "W1" },
          ],
        }),
      ),
    );
    const r = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "400.00", date: "2024-04-01" },
          entries: [
            { date: "2024-04-10", amount: "20.00", sign: "DBIT", ref: "W2" },
          ],
        }),
      ),
    );
    const [newest] = await listImports(user.id, account.id);
    expect(newest!.id).toBe(r.importId);
    expect(newest!.warnings).toHaveLength(1);
  });

  it("another user cannot confirm someone else's pending upload", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    await expect(confirmImport(other.id, id)).rejects.toThrow(/not found/);
    expect(txCount(account.id)).toBe(0);
    await expect(readPending(user.id, id)).resolves.toBeDefined();
  });
});

describe("listImports / undoImport", () => {
  it("lists newest first with counts and dates", async () => {
    const { user, account } = await setup();
    const a = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const b = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-b.xml"),
    );
    const list = await listImports(user.id, account.id);
    expect(list.map((i) => i.id)).toEqual([b.importId, a.importId]);
    expect(list[0]).toMatchObject({
      accountName: account.name,
      currency: "CHF",
      format: "camt053",
      newCount: 2,
      duplicateCount: 3,
      statementFrom: "2024-07-05",
      statementTo: "2024-07-15",
      closingBalance: 118750,
      warnings: [],
    });
    expect(typeof list[0]!.createdAt).toBe("number");
    expect(listRecentImports(user.id, 1).map((i) => i.id)).toEqual([
      b.importId,
    ]);
  });

  it("undo removes the import's rows and snapshot, leaving other imports intact", async () => {
    const { user, account } = await setup();
    const a = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const b = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-b.xml"),
    );
    expect(undoImport(user.id, b.importId)).toEqual({
      accountId: account.id,
      removedTransactions: 2,
    });
    expect(txCount(account.id)).toBe(5);
    const remaining = getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all();
    expect(remaining.every((t) => t.importId === a.importId)).toBe(true);
    const snaps = getDB()
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, account.id))
      .all();
    expect(snaps.map((s) => s.date)).toEqual(["2024-07-10"]);
    expect((await listImports(user.id, account.id)).map((i) => i.id)).toEqual([
      a.importId,
    ]);
  });

  it("a snapshot re-pointed to a newer import survives undo of the older one", async () => {
    const { user, account } = await setup();
    const make = (closing: string, ref: string) =>
      buildCamt({
        iban: EXAMPLE_IBAN,
        closing: { amount: closing, date: "2024-05-31" },
        entries: [{ date: "2024-05-02", amount: "1.00", sign: "CRDT", ref }],
      });
    const older = await confirmImport(
      user.id,
      await uploadBytes(user.id, account.id, make("10.00", "S1")),
    );
    const newer = await confirmImport(
      user.id,
      await uploadBytes(user.id, account.id, make("12.00", "S2")),
    );
    undoImport(user.id, older.importId);
    const snap = getDB()
      .select()
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.accountId, account.id),
          eq(balanceSnapshots.date, "2024-05-31"),
        ),
      )
      .all();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ importId: newer.importId, amount: 1200 });
    expect(txCount(account.id)).toBe(1);
  });

  it("another user can neither list nor undo an import", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const a = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    await expect(listImports(other.id, account.id)).rejects.toThrow(
      /not found/,
    );
    expect(listRecentImports(other.id)).toEqual([]);
    expect(() => undoImport(other.id, a.importId)).toThrow(/not found/);
    expect(txCount(account.id)).toBe(5);
  });

  it("undo checks the account when one is given", async () => {
    const { user, account } = await setup();
    const a = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    expect(() => undoImport(user.id, a.importId, "some-other-account")).toThrow(
      /not found/,
    );
    expect(txCount(account.id)).toBe(5);
  });

  it("categorizes new rows with the user's rules only", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const mine = await createCategory(user.id, {
      name: "Incoming",
      kind: "income",
      parentId: null,
      color: null,
      icon: null,
    });
    const theirs = await createCategory(other.id, {
      name: "Theirs",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await createRule(user.id, {
      categoryId: mine.id,
      priority: 100,
      counterpartyContains: null,
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: "income",
    });
    await createRule(other.id, {
      categoryId: theirs.id,
      priority: 100,
      counterpartyContains: null,
      descriptionContains: null,
      counterpartyIban: null,
      amountSign: "expense",
    });
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const rows = getDB()
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all();
    expect(rows.some((t) => t.amount > 0)).toBe(true);
    for (const t of rows) {
      expect(t.categoryId).toBe(t.amount > 0 ? mine.id : null);
    }
  });
});
