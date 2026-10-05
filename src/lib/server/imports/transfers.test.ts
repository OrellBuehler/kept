import { useTestStore } from "$lib/testing/store";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDB, transactions, transfers } from "$lib/server/db";
import { createCategory } from "$lib/server/categories/categories";
import { currentBalance } from "$lib/server/ledger/balances";
import { getTransaction } from "$lib/server/ledger/transactions";
import { unlink } from "$lib/server/transfers";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
} from "$lib/testing/fixtures/bill-identifiers";
import { buildCamt, type CamtEntry } from "$lib/testing/fixtures/camt053/build";
import { uploadBytes } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { confirmImport } from "./confirm";
import { undoImport } from "./history";
import { buildPreview } from "./preview";

useTestDB();
useTestStore();

async function setup(fill = true) {
  const user = await createTestUser();
  const a = await seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
  const b = await seedAccount(user.id, {
    name: "Savings",
    type: "savings",
    iban: EXAMPLE_IBAN_OTHER,
    openingDate: "2024-01-01",
    fillFromTransfers: fill,
  });
  return { user, a, b };
}

const entry = (over: Partial<CamtEntry> = {}): CamtEntry => ({
  date: "2024-03-10",
  amount: "100.00",
  sign: "DBIT",
  ref: "R1",
  counterpartyIban: EXAMPLE_IBAN_OTHER,
  ...over,
});

const statementA = (entries: CamtEntry[], over = {}) =>
  buildCamt({ iban: EXAMPLE_IBAN, entries, ...over });
const statementB = (entries: CamtEntry[], over = {}) =>
  buildCamt({ iban: EXAMPLE_IBAN_OTHER, entries, ...over });

const rowsOf = (accountId: string) =>
  getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all();
const allTransfers = () => getDB().select().from(transfers).all();

describe("confirmImport links transfers", () => {
  it("mirrors a transfer onto an account filled from transfers", async () => {
    const { user, a, b } = await setup();
    const result = await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, statementA([entry()])),
    );
    expect(result).toMatchObject({
      newCount: 1,
      transfers: { paired: 0, mirrored: 1, replaced: 0, needsAmount: 0 },
    });
    expect(rowsOf(b.id)).toEqual([
      expect.objectContaining({
        source: "mirror",
        amount: 10000,
        counterpartyName: "Main",
        counterpartyIban: EXAMPLE_IBAN,
      }),
    ]);
    expect(await currentBalance(user.id, b.id, "2024-12-31")).toBe(10000);
  });

  it("creates nothing when the other account is not filled from transfers", async () => {
    const { user, a, b } = await setup(false);
    const result = await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, statementA([entry()])),
    );
    expect(result.transfers).toEqual({
      paired: 0,
      mirrored: 0,
      replaced: 0,
      needsAmount: 0,
    });
    expect(rowsOf(b.id)).toEqual([]);
    expect(allTransfers()).toEqual([]);
  });

  it("uses the counter-amount of a foreign-currency transfer, or asks for it", async () => {
    const user = await createTestUser();
    const a = await seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const eur = await seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const result = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        statementA([
          entry({ original: { amount: "93.00", currency: "EUR" } }),
          entry({ ref: "R2", date: "2024-03-20" }),
        ]),
      ),
    );
    expect(result.transfers).toMatchObject({ mirrored: 1, needsAmount: 1 });
    expect(rowsOf(eur.id)).toEqual([
      expect.objectContaining({ amount: 9300, currency: "EUR" }),
    ]);
  });

  it("pairs with a row that is already on the other account", async () => {
    const { user, a, b } = await setup(false);
    await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, statementA([entry()])),
    );
    const result = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        b.id,
        statementB([
          entry({
            date: "2024-03-12",
            sign: "CRDT",
            counterpartyIban: undefined,
          }),
        ]),
      ),
    );
    // The statement names no counterparty, so the earlier row finds its partner.
    expect(result.transfers).toMatchObject({ paired: 1, mirrored: 0 });
    expect(allTransfers()).toEqual([
      expect.objectContaining({ status: "linked", method: "paired" }),
    ]);
  });

  it("pairs a debit that waits for an amount with the later foreign-currency import", async () => {
    const user = await createTestUser();
    const a = await seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const eur = await seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const first = await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, statementA([entry()])),
    );
    expect(first.transfers.needsAmount).toBe(1);
    const second = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        eur.id,
        buildCamt({
          iban: EXAMPLE_IBAN_OTHER,
          currency: "EUR",
          entries: [
            entry({
              date: "2024-03-11",
              amount: "93.00",
              sign: "CRDT",
              ref: "R9",
              counterpartyIban: EXAMPLE_IBAN,
              original: { amount: "100.00", currency: "CHF" },
            }),
          ],
        }),
      ),
    );
    expect(second.transfers).toMatchObject({ paired: 1, needsAmount: 0 });
    expect(allTransfers()).toEqual([
      expect.objectContaining({ status: "linked", method: "paired" }),
    ]);
    expect(rowsOf(eur.id)).toEqual([
      expect.objectContaining({ source: "import", amount: 9300 }),
    ]);
  });

  it("undoing the source import removes the mirror, and a repeat import brings it back", async () => {
    const { user, a, b } = await setup();
    const bytes = statementA([entry()]);
    const first = await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, bytes),
    );
    expect(rowsOf(b.id)).toHaveLength(1);
    undoImport(user.id, first.importId);
    expect(rowsOf(b.id)).toEqual([]);
    expect(allTransfers()).toEqual([]);
    await confirmImport(user.id, await uploadBytes(user.id, a.id, bytes));
    expect(rowsOf(b.id)).toHaveLength(1);
  });

  it("does not recreate a mirror the user unlinked when the file is imported again", async () => {
    const { user, a, b } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        statementA([entry(), entry({ ref: "R2", date: "2024-04-01" })]),
      ),
    );
    const mirror = rowsOf(b.id).find((r) => r.bookingDate === "2024-03-10")!;
    await unlink(
      user.id,
      (await getTransaction(user.id, mirror.id)).transfer!.id,
    );
    const again = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        statementA([
          entry(),
          entry({ ref: "R2", date: "2024-04-01" }),
          entry({ ref: "R3", date: "2024-05-01" }),
        ]),
      ),
    );
    expect(again.newCount).toBe(1);
    expect(
      rowsOf(b.id)
        .map((r) => r.bookingDate)
        .sort(),
    ).toEqual(["2024-04-01", "2024-05-01"]);
  });
});

describe("a later real import replaces mirrors", () => {
  async function mirrored() {
    const { user, a, b } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        statementA([
          entry(),
          entry({ ref: "R2", date: "2024-03-20", amount: "40.00" }),
        ]),
      ),
    );
    return { user, a, b };
  }
  const incoming = (over: Partial<CamtEntry> = {}) =>
    entry({
      date: "2024-03-12",
      sign: "CRDT",
      counterpartyIban: EXAMPLE_IBAN,
      ...over,
    });

  it("marks matching rows in the preview and counts the replacement", async () => {
    const { user, b } = await mirrored();
    const mirror = rowsOf(b.id).find((r) => r.amount === 10000)!;
    const pendingId = await uploadBytes(
      user.id,
      b.id,
      statementB([
        incoming(),
        incoming({ ref: "R9", date: "2024-03-25", amount: "7.00" }),
      ]),
    );
    const preview = await buildPreview(user.id, pendingId);
    expect(preview.rows.map((r) => [r.status, r.mirrorId])).toEqual([
      ["replaces_mirror", mirror.id],
      ["new", null],
    ]);
    expect(preview.counts).toEqual({
      new: 2,
      replacesMirror: 1,
      duplicate: 0,
      total: 2,
    });
  });

  it("takes over the mirror, keeps the link and carries note and category", async () => {
    const { user, a, b } = await mirrored();
    const mirror = rowsOf(b.id).find((r) => r.amount === 10000)!;
    const cat = await createCategory(user.id, {
      name: "Moves",
      kind: "income",
      parentId: null,
      color: null,
      icon: null,
    });
    getDB()
      .update(transactions)
      .set({ note: "my note", categoryId: cat.id })
      .where(eq(transactions.id, mirror.id))
      .run();
    const before = allTransfers().find((t) => t.inTransactionId === mirror.id)!;

    const result = await confirmImport(
      user.id,
      await uploadBytes(user.id, b.id, statementB([incoming()])),
    );
    expect(result).toMatchObject({
      newCount: 1,
      transfers: { replaced: 1, paired: 0, mirrored: 0 },
    });
    expect(rowsOf(b.id).some((r) => r.id === mirror.id)).toBe(false);
    const real = rowsOf(b.id).find((r) => r.source === "import")!;
    expect(real).toMatchObject({ note: "my note", categoryId: cat.id });
    const after = allTransfers().find((t) => t.id === before.id)!;
    expect(after).toMatchObject({
      status: "linked",
      method: "paired",
      inTransactionId: real.id,
      outTransactionId: before.outTransactionId,
      fromAccountId: a.id,
      toAccountId: b.id,
    });
    expect(allTransfers()).toHaveLength(2);
    expect(await currentBalance(user.id, b.id, "2024-12-31")).toBe(14000);
  });

  it("does not warn about the balance when the real row replaces the mirror", async () => {
    const { user, b } = await mirrored();
    const withReplacement = await buildPreview(
      user.id,
      await uploadBytes(
        user.id,
        b.id,
        statementB(
          [
            incoming(),
            incoming({ ref: "R9", date: "2024-03-20", amount: "40.00" }),
          ],
          {
            opening: { amount: "0.00", date: "2024-03-01" },
            closing: { amount: "140.00", date: "2024-03-31" },
          },
        ),
      ),
    );
    expect(withReplacement.counts.replacesMirror).toBe(2);
    expect(withReplacement.balanceWarnings).toEqual([]);
  });

  it("flags a mirror that no real row replaced inside a statement period", async () => {
    const { user, b } = await mirrored();
    const result = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        b.id,
        statementB([incoming()], {
          opening: { amount: "0.00", date: "2024-03-01" },
          closing: { amount: "100.00", date: "2024-03-31" },
        }),
      ),
    );
    expect(result.transfers.replaced).toBe(1);
    const left = rowsOf(b.id).find((r) => r.source === "mirror")!;
    expect(left).toMatchObject({ amount: 4000 });
    expect((await getTransaction(user.id, left.id)).mirrorOf).toMatchObject({
      noBankCounterpart: true,
    });
  });

  it("matches only the right amount, date and counterparty", async () => {
    const { user, b } = await mirrored();
    const preview = await buildPreview(
      user.id,
      await uploadBytes(
        user.id,
        b.id,
        statementB([
          incoming({ amount: "100.01", ref: "A" }),
          incoming({ date: "2024-03-18", ref: "B" }),
          incoming({ counterpartyIban: EXAMPLE_IBAN_THIRD, ref: "C" }),
        ]),
      ),
    );
    expect(preview.rows.map((r) => r.status)).toEqual(["new", "new", "new"]);
    expect(preview.counts.replacesMirror).toBe(0);
  });

  it("undoing the later import restores the mirrors", async () => {
    const { user, b } = await mirrored();
    const result = await confirmImport(
      user.id,
      await uploadBytes(user.id, b.id, statementB([incoming()])),
    );
    expect(rowsOf(b.id).filter((r) => r.source === "mirror")).toHaveLength(1);
    undoImport(user.id, result.importId);
    expect(rowsOf(b.id).filter((r) => r.source === "mirror")).toHaveLength(2);
    expect(rowsOf(b.id).some((r) => r.source === "import")).toBe(false);
  });

  it("does not touch another user's mirrors", async () => {
    const { user, b } = await mirrored();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, {
      name: "Theirs",
      iban: EXAMPLE_IBAN_OTHER,
    });
    const preview = await buildPreview(
      other.id,
      await uploadBytes(other.id, theirs.id, statementB([incoming()])),
    );
    expect(preview.rows.map((r) => r.status)).toEqual(["new"]);
    await confirmImport(
      other.id,
      await uploadBytes(other.id, theirs.id, statementB([incoming()])),
    );
    expect(rowsOf(b.id).filter((r) => r.source === "mirror")).toHaveLength(2);
    expect(
      getDB()
        .select()
        .from(transfers)
        .where(
          and(eq(transfers.userId, user.id), eq(transfers.method, "paired")),
        )
        .all(),
    ).toEqual([]);
  });
});
