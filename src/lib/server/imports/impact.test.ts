import { useTestStore } from "$lib/testing/store";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  billAllocations,
  getDB,
  pillar3aContributions,
  transactions,
} from "$lib/server/db";
import { createCategory } from "$lib/server/categories/categories";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { buildCamt, type CamtEntry } from "$lib/testing/fixtures/camt053/build";
import { uploadBytes } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { seedPortfolio } from "$lib/testing/pillar3a";
import { confirmImport } from "./confirm";
import {
  getImportImpact,
  getImportImpacts,
  hasImportImpact,
  undoImport,
} from "./history";
import { eq } from "drizzle-orm";
import { LedgerError } from "$lib/server/ledger/errors";

useTestDB();
useTestStore();

const entry = (over: Partial<CamtEntry> = {}): CamtEntry => ({
  date: "2024-03-10",
  amount: "100.00",
  sign: "DBIT",
  ref: "R1",
  counterpartyIban: EXAMPLE_IBAN_OTHER,
  ...over,
});

async function setup() {
  const user = await createTestUser();
  const a = seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
  const b = seedAccount(user.id, {
    name: "Savings",
    type: "savings",
    iban: EXAMPLE_IBAN_OTHER,
    openingDate: "2024-01-01",
    fillFromTransfers: true,
  });
  return { user, a, b };
}

const rowsOf = (accountId: string) =>
  getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all();

describe("getImportImpact", () => {
  it("is all zero for an untouched import without transfers", async () => {
    const { user, a } = await setup();
    const done = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          entries: [entry({ counterpartyIban: undefined })],
        }),
      ),
    );
    const impact = getImportImpact(user.id, done.importId);
    expect(impact).toEqual({
      transactions: 1,
      categorized: 0,
      notes: 0,
      taxYears: 0,
      deductionYears: 0,
      billAllocations: 0,
      pillar3a: 0,
      transferLinks: 0,
      mirrors: 0,
    });
    expect(hasImportImpact(impact)).toBe(false);
  });

  it("counts the user edits on the rows the import added", async () => {
    const { user, a, b } = await setup();
    const done = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          entries: [
            entry(),
            entry({
              ref: "R2",
              date: "2024-03-11",
              counterpartyIban: undefined,
            }),
            entry({
              ref: "R3",
              date: "2024-03-12",
              counterpartyIban: undefined,
            }),
            entry({
              ref: "R4",
              date: "2024-03-13",
              counterpartyIban: undefined,
            }),
          ],
        }),
      ),
    );
    const [r1, r2, r3, r4] = rowsOf(a.id).sort((x, y) =>
      x.bookingDate.localeCompare(y.bookingDate),
    );
    const category = createCategory(user.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    const db = getDB();
    db.update(transactions)
      .set({ categoryId: category.id, note: "lunch" })
      .where(eq(transactions.id, r2!.id))
      .run();
    db.update(transactions)
      .set({ taxYear: 2024 })
      .where(eq(transactions.id, r3!.id))
      .run();
    db.update(transactions)
      .set({ deductionYear: 2025 })
      .where(eq(transactions.id, r4!.id))
      .run();
    const bill = seedBill(user.id);
    db.insert(billAllocations)
      .values({
        userId: user.id,
        billId: bill.id,
        transactionId: r2!.id,
        amount: minor(10000),
        origin: "user",
      })
      .run();
    const portfolio = seedPortfolio(
      user.id,
      seedAccount(user.id, { name: "Pension", type: "pillar_3a" }).id,
    );
    db.insert(pillar3aContributions)
      .values({
        userId: user.id,
        portfolioId: portfolio.id,
        transactionId: r3!.id,
        date: "2024-03-12",
        amount: minor(100),
        kind: "ordinary",
      })
      .run();

    expect(rowsOf(b.id)).toHaveLength(1);
    const impact = getImportImpact(user.id, done.importId);
    expect(impact).toEqual({
      transactions: 4,
      categorized: 1,
      notes: 1,
      taxYears: 1,
      deductionYears: 1,
      billAllocations: 1,
      pillar3a: 1,
      transferLinks: 1,
      mirrors: 1,
    });
    expect(hasImportImpact(impact)).toBe(true);
    expect(r1).toBeDefined();
  });

  it("matches what undo removes", async () => {
    const { user, a, b } = await setup();
    const done = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({ iban: EXAMPLE_IBAN, entries: [entry()] }),
      ),
    );
    const impact = getImportImpact(user.id, done.importId);
    expect(impact.mirrors).toBe(1);
    undoImport(user.id, done.importId);
    expect(rowsOf(a.id)).toHaveLength(0);
    expect(rowsOf(b.id)).toHaveLength(0);
  });

  it("does not see another user's import", async () => {
    const { user, a } = await setup();
    const done = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({ iban: EXAMPLE_IBAN, entries: [entry()] }),
      ),
    );
    const other = await createTestUser();
    expect(() => getImportImpact(other.id, done.importId)).toThrow(LedgerError);
  });

  it("batches several imports and agrees with the single lookup", async () => {
    const { user, a } = await setup();
    const first = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({ iban: EXAMPLE_IBAN, entries: [entry()] }),
      ),
    );
    const second = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          entries: [
            entry({
              ref: "R9",
              date: "2024-04-01",
              counterpartyIban: undefined,
            }),
          ],
        }),
      ),
    );
    const impacts = getImportImpacts(user.id, [
      first.importId,
      second.importId,
    ]);
    expect(impacts.get(first.importId)).toEqual(
      getImportImpact(user.id, first.importId),
    );
    expect(impacts.get(second.importId)).toEqual(
      getImportImpact(user.id, second.importId),
    );
    expect(impacts.get(first.importId)).toMatchObject({
      transactions: 1,
      transferLinks: 1,
      mirrors: 1,
    });
    expect(impacts.get(second.importId)).toMatchObject({
      transactions: 1,
      transferLinks: 0,
      mirrors: 0,
    });
  });

  it("leaves out unknown ids and other users' imports in the batch", async () => {
    const { user, a } = await setup();
    const done = await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        a.id,
        buildCamt({ iban: EXAMPLE_IBAN, entries: [entry()] }),
      ),
    );
    const other = await createTestUser();
    expect(getImportImpacts(other.id, [done.importId, "nope"]).size).toBe(0);
    expect(getImportImpacts(user.id, []).size).toBe(0);
  });
});
