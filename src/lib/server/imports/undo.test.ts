import { useTestStore } from "$lib/testing/store";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { balanceSnapshots, getDB, transactions } from "$lib/server/db";
import { archiveAccount } from "$lib/server/ledger/accounts";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { buildCamt } from "$lib/testing/fixtures/camt053/build";
import { uploadBytes, uploadFixture } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { confirmImport } from "./confirm";
import { undoImport } from "./history";

useTestDB();
useTestStore();

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
  return { user, account };
}

const snapshotsOf = (accountId: string) =>
  getDB()
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId))
    .all();
const txCount = (accountId: string) =>
  getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all().length;

const statement = (closing: string, ref: string) =>
  buildCamt({
    iban: EXAMPLE_IBAN,
    closing: { amount: closing, date: "2024-05-31" },
    entries: [{ date: "2024-05-02", amount: "1.00", sign: "CRDT", ref }],
  });

describe("undo keeps balance anchors", () => {
  it("undoing an empty re-import leaves the snapshot of the original import", async () => {
    const { user, account } = await setup();
    const first = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const again = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    expect(snapshotsOf(account.id)[0]!.importId).toBe(first.importId);
    undoImport(user.id, again.importId);
    const snaps = snapshotsOf(account.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      amount: 123250,
      importId: first.importId,
    });
    expect(txCount(account.id)).toBe(5);
  });

  it("undoing the newer import restores the older import's closing snapshot", async () => {
    const { user, account } = await setup();
    const older = await confirmImport(
      user.id,
      await uploadBytes(user.id, account.id, statement("10.00", "R1")),
    );
    const newer = await confirmImport(
      user.id,
      await uploadBytes(user.id, account.id, statement("12.00", "R2")),
    );
    undoImport(user.id, newer.importId);
    const snaps = snapshotsOf(account.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      amount: 1000,
      importId: older.importId,
      date: "2024-05-31",
    });
  });

  it("undoing the only import with that closing date removes the snapshot", async () => {
    const { user, account } = await setup();
    const a = await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    undoImport(user.id, a.importId);
    expect(snapshotsOf(account.id)).toEqual([]);
  });
});

describe("confirm re-checks the account", () => {
  it("refuses an account archived after the upload", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    archiveAccount(user.id, account.id);
    await expect(confirmImport(user.id, id)).rejects.toThrow(/archived/);
    expect(txCount(account.id)).toBe(0);
  });
});
