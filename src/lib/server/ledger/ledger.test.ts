import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  csvProfiles,
  getDB,
  imports,
  transactions,
} from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { maskIban } from "$lib/iban";
import { LEDGER_IBAN_A, LEDGER_IBAN_B } from "$lib/testing/fixtures/ledger";
import {
  seedAccount,
  seedImport,
  seedImportedTransaction,
  seedInstitution,
} from "$lib/testing/ledger";
import {
  archiveAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  unarchiveAccount,
  updateAccount,
} from "./accounts";
import { LedgerError } from "./errors";
import {
  createInstitution,
  deleteInstitution,
  getInstitution,
  listInstitutions,
  updateInstitution,
} from "./institutions";
import type { TransactionInput } from "./schemas";
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
} from "./snapshots";
import {
  createManualTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "./transactions";

const txInput = (over: Partial<TransactionInput> = {}): TransactionInput => ({
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

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof LedgerError) return `${err.code}:${err.field ?? ""}`;
    throw err;
  }
  return undefined;
}

describe("institutions", () => {
  useTestDB();

  it("creates, lists (with account counts), updates and deletes", async () => {
    const u = await createTestUser();
    const inst = createInstitution(u.id, {
      name: "Beta",
      bic: null,
      color: null,
    });
    createInstitution(u.id, {
      name: "Alpha",
      bic: "AAAACHZZ",
      color: "#112233",
    });
    seedAccount(u.id, { institutionId: inst.id });

    expect(listInstitutions(u.id).map((i) => [i.name, i.accountCount])).toEqual(
      [
        ["Alpha", 0],
        ["Beta", 1],
      ],
    );
    const updated = updateInstitution(u.id, inst.id, {
      name: "Gamma",
      bic: null,
      color: "#ffffff",
    });
    expect(updated).toMatchObject({ name: "Gamma", color: "#ffffff" });
  });

  it("enforces unique names per user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const first = seedInstitution(a.id, "Same");
    expect(code(() => seedInstitution(a.id, "Same"))).toBe("conflict:name");
    expect(() => seedInstitution(b.id, "Same")).not.toThrow();
    const other = seedInstitution(a.id, "Other");
    expect(
      code(() =>
        updateInstitution(a.id, other.id, {
          name: "Same",
          bic: null,
          color: null,
        }),
      ),
    ).toBe("conflict:name");
    expect(() =>
      updateInstitution(a.id, first.id, {
        name: "Same",
        bic: null,
        color: null,
      }),
    ).not.toThrow();
  });

  it("refuses deletion while accounts reference it", async () => {
    const u = await createTestUser();
    const inst = seedInstitution(u.id);
    const acc = seedAccount(u.id, { institutionId: inst.id });
    expect(code(() => deleteInstitution(u.id, inst.id))).toBe("conflict:");
    deleteAccount(u.id, acc.id);
    deleteInstitution(u.id, inst.id);
    expect(listInstitutions(u.id)).toEqual([]);
  });

  it("is invisible to other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const inst = seedInstitution(a.id);
    expect(listInstitutions(b.id)).toEqual([]);
    expect(code(() => getInstitution(b.id, inst.id))).toBe("not_found:");
    expect(
      code(() =>
        updateInstitution(b.id, inst.id, { name: "x", bic: null, color: null }),
      ),
    ).toBe("not_found:");
    expect(code(() => deleteInstitution(b.id, inst.id))).toBe("not_found:");
    expect(getInstitution(a.id, inst.id).name).toBe("Test Institution");
  });
});

describe("accounts", () => {
  useTestDB();

  it("creates with defaults and exposes balance, masked IBAN and institution", async () => {
    const u = await createTestUser();
    const inst = seedInstitution(u.id);
    const acc = seedAccount(u.id, {
      institutionId: inst.id,
      iban: LEDGER_IBAN_A,
      openingBalance: minor(10000),
    });
    expect(acc).toMatchObject({
      archived: false,
      balance: 10000,
      iban: LEDGER_IBAN_A,
      ibanMasked: maskIban(LEDGER_IBAN_A),
      institution: { id: inst.id, name: "Test Institution", color: null },
      lastBookingDate: null,
      lastImportAt: null,
      sortOrder: 0,
    });
    expect(seedAccount(u.id, { name: "Second" }).sortOrder).toBe(1);
  });

  it("reports last booking date, last import and current balance in the list", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id, { openingBalance: minor(100) });
    seedImportedTransaction(u.id, acc.id, {
      bookingDate: "2024-02-01",
      amount: minor(-30),
    });
    seedImportedTransaction(u.id, acc.id, {
      bookingDate: "2024-03-01",
      amount: minor(5),
    });
    const imp = seedImport(u.id, acc.id);
    const [listed] = listAccounts(u.id);
    expect(listed).toMatchObject({
      balance: 75,
      lastBookingDate: "2024-03-01",
      lastImportAt: imp.createdAt.getTime(),
    });
  });

  it("orders by sortOrder then name", async () => {
    const u = await createTestUser();
    seedAccount(u.id, { name: "B", sortOrder: 1 });
    seedAccount(u.id, { name: "A", sortOrder: 1 });
    seedAccount(u.id, { name: "Z", sortOrder: 0 });
    expect(listAccounts(u.id).map((a) => a.name)).toEqual(["Z", "A", "B"]);
  });

  it("enforces a unique IBAN per user, but allows several without one", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    seedAccount(a.id, { iban: LEDGER_IBAN_A });
    expect(code(() => seedAccount(a.id, { iban: LEDGER_IBAN_A }))).toBe(
      "conflict:iban",
    );
    expect(() => seedAccount(b.id, { iban: LEDGER_IBAN_A })).not.toThrow();
    expect(() => seedAccount(a.id, { name: "n1" })).not.toThrow();
    expect(() => seedAccount(a.id, { name: "n2" })).not.toThrow();
    const other = seedAccount(a.id, { iban: LEDGER_IBAN_B });
    expect(
      code(() =>
        updateAccount(a.id, other.id, {
          ...accountToInput(other),
          iban: LEDGER_IBAN_A,
        }),
      ),
    ).toBe("conflict:iban");
  });

  it("rejects an institution of another user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const inst = seedInstitution(a.id);
    expect(code(() => seedAccount(b.id, { institutionId: inst.id }))).toBe(
      "invalid:institutionId",
    );
  });

  it("updates, and blocks currency changes once data exists", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const renamed = updateAccount(u.id, acc.id, {
      ...accountToInput(acc),
      name: "Renamed",
      currency: "EUR",
    });
    expect(renamed).toMatchObject({ name: "Renamed", currency: "EUR" });
    seedImportedTransaction(u.id, acc.id, { currency: "EUR" });
    expect(
      code(() =>
        updateAccount(u.id, acc.id, {
          ...accountToInput(renamed),
          currency: "CHF",
        }),
      ),
    ).toBe("conflict:currency");
    expect(
      updateAccount(u.id, acc.id, {
        ...accountToInput(renamed),
        sortOrder: null,
      }).sortOrder,
    ).toBe(renamed.sortOrder);
  });

  it("archives and unarchives", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    expect(archiveAccount(u.id, acc.id).archived).toBe(true);
    expect(listAccounts(u.id)[0]!.archived).toBe(true);
    expect(unarchiveAccount(u.id, acc.id).archived).toBe(false);
  });

  it("hard delete cascades to transactions, imports, snapshots and profiles", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const keep = seedAccount(u.id, { name: "Keep" });
    const imp = seedImport(u.id, acc.id);
    seedImportedTransaction(u.id, acc.id, { importId: imp.id });
    seedImportedTransaction(u.id, keep.id);
    createManualTransaction(u.id, acc.id, txInput());
    createSnapshot(u.id, acc.id, {
      date: "2024-01-01",
      amount: minor(1),
      note: null,
    });
    getDB()
      .insert(csvProfiles)
      .values({ userId: u.id, accountId: acc.id, name: "p", profile: "{}" })
      .run();

    deleteAccount(u.id, acc.id);

    const db = getDB();
    expect(db.select().from(transactions).all()).toHaveLength(1);
    expect(db.select().from(imports).all()).toHaveLength(0);
    expect(db.select().from(balanceSnapshots).all()).toHaveLength(0);
    expect(db.select().from(csvProfiles).all()).toHaveLength(0);
    expect(db.select().from(accounts).all()).toHaveLength(1);
  });

  it("is invisible and untouchable for other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = seedAccount(a.id, { iban: LEDGER_IBAN_A });
    expect(listAccounts(b.id)).toEqual([]);
    expect(code(() => getAccount(b.id, acc.id))).toBe("not_found:");
    expect(
      code(() =>
        updateAccount(b.id, acc.id, { ...accountToInput(acc), name: "x" }),
      ),
    ).toBe("not_found:");
    expect(code(() => archiveAccount(b.id, acc.id))).toBe("not_found:");
    expect(code(() => unarchiveAccount(b.id, acc.id))).toBe("not_found:");
    expect(code(() => deleteAccount(b.id, acc.id))).toBe("not_found:");
    expect(getAccount(a.id, acc.id)).toMatchObject({
      name: "Main",
      archived: false,
    });
  });
});

function accountToInput(a: ReturnType<typeof getAccount>) {
  return {
    institutionId: a.institution?.id ?? null,
    name: a.name,
    type: a.type,
    currency: a.currency,
    iban: a.iban,
    openingBalance: a.openingBalance,
    openingDate: a.openingDate,
    shareBps: a.shareBps,
    sharedWith: a.sharedWith,
    sortOrder: a.sortOrder,
  };
}

describe("transactions", () => {
  useTestDB();

  it("creates manual rows in the account currency with a manual external id", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id, { currency: "EUR" });
    const t = createManualTransaction(
      u.id,
      acc.id,
      txInput({ description: "Lunch", counterpartyName: "Cafe" }),
    );
    expect(t).toMatchObject({
      source: "manual",
      currency: "EUR",
      amount: -500,
      importId: null,
      reversal: false,
    });
    expect(t.externalId).toMatch(/^manual:[0-9a-f-]{36}$/);
  });

  it("lists newest first with pagination", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    for (let day = 1; day <= 7; day++) {
      createManualTransaction(
        u.id,
        acc.id,
        txInput({ bookingDate: `2024-03-0${day}`, amount: minor(day) }),
      );
    }
    const p1 = listTransactions(u.id, acc.id, { pageSize: 3 });
    expect(p1).toMatchObject({ total: 7, page: 1, pageSize: 3, pageCount: 3 });
    expect(p1.items.map((t) => t.bookingDate)).toEqual([
      "2024-03-07",
      "2024-03-06",
      "2024-03-05",
    ]);
    const p3 = listTransactions(u.id, acc.id, { pageSize: 3, page: 3 });
    expect(p3.items.map((t) => t.bookingDate)).toEqual(["2024-03-01"]);
    expect(listTransactions(u.id, acc.id, { pageSize: 3, page: 99 }).page).toBe(
      3,
    );
  });

  it("orders rows of the same day newest-inserted first", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    for (const amount of [1, 2, 3]) {
      createManualTransaction(u.id, acc.id, txInput({ amount: minor(amount) }));
    }
    expect(listTransactions(u.id, acc.id).items.map((t) => t.amount)).toEqual([
      3, 2, 1,
    ]);
  });

  it("filters by date range, amount range and text", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    createManualTransaction(
      u.id,
      acc.id,
      txInput({
        bookingDate: "2024-01-10",
        amount: minor(-2000),
        description: "Rent January",
      }),
    );
    createManualTransaction(
      u.id,
      acc.id,
      txInput({
        bookingDate: "2024-02-10",
        amount: minor(-150),
        counterpartyName: "Corner Shop",
      }),
    );
    createManualTransaction(
      u.id,
      acc.id,
      txInput({
        bookingDate: "2024-03-10",
        amount: minor(300),
        description: "100% refund_x",
      }),
    );
    const ids = (filters: Parameters<typeof listTransactions>[2]) =>
      listTransactions(u.id, acc.id, filters).items.map((t) => t.bookingDate);

    expect(ids({ filters: { from: "2024-02-01" } })).toEqual([
      "2024-03-10",
      "2024-02-10",
    ]);
    expect(ids({ filters: { to: "2024-02-10" } })).toEqual([
      "2024-02-10",
      "2024-01-10",
    ]);
    expect(ids({ filters: { from: "2024-02-10", to: "2024-02-10" } })).toEqual([
      "2024-02-10",
    ]);
    expect(ids({ filters: { minAmount: minor(-200) } })).toEqual([
      "2024-03-10",
      "2024-02-10",
    ]);
    expect(ids({ filters: { maxAmount: minor(-200) } })).toEqual([
      "2024-01-10",
    ]);
    expect(ids({ filters: { q: "rent" } })).toEqual(["2024-01-10"]);
    expect(ids({ filters: { q: "corner" } })).toEqual(["2024-02-10"]);
    expect(ids({ filters: { q: "100%" } })).toEqual(["2024-03-10"]);
    expect(ids({ filters: { q: "%" } })).toEqual(["2024-03-10"]);
    expect(ids({ filters: { q: "_x" } })).toEqual(["2024-03-10"]);
    expect(ids({ filters: { q: "nothing" } })).toEqual([]);
    expect(
      listTransactions(u.id, acc.id, { filters: { q: "nothing" } }),
    ).toMatchObject({ total: 0, page: 1, pageCount: 1 });
  });

  it("manual rows are fully editable, imported rows only take a note", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const manual = createManualTransaction(u.id, acc.id, txInput());
    const edited = updateTransaction(
      u.id,
      manual.id,
      txInput({ amount: minor(-900), description: "Edited", note: "n" }),
    );
    expect(edited).toMatchObject({
      amount: -900,
      description: "Edited",
      note: "n",
    });
    expect(edited.externalId).toBe(manual.externalId);

    const imported = seedImportedTransaction(u.id, acc.id, {
      description: "Original",
      amount: minor(-1234),
    });
    const noted = updateTransaction(u.id, imported.id, { note: "my note" });
    expect(noted).toMatchObject({
      note: "my note",
      description: "Original",
      amount: -1234,
    });
    // Even a full payload must not change imported data.
    const again = updateTransaction(
      u.id,
      imported.id,
      txInput({ amount: minor(1), description: "Hacked", note: "again" }),
    );
    expect(again).toMatchObject({
      note: "again",
      description: "Original",
      amount: -1234,
    });
  });

  it("rejects booking dates before the account's opening date", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id, { openingDate: "2024-03-01" });
    expect(
      code(() =>
        createManualTransaction(
          u.id,
          acc.id,
          txInput({ bookingDate: "2024-02-29" }),
        ),
      ),
    ).toBe("invalid:bookingDate");
    const ok = createManualTransaction(
      u.id,
      acc.id,
      txInput({ bookingDate: "2024-03-01" }),
    );
    expect(
      code(() =>
        updateTransaction(u.id, ok.id, txInput({ bookingDate: "2024-01-01" })),
      ),
    ).toBe("invalid:bookingDate");
    expect(getTransaction(u.id, ok.id).bookingDate).toBe("2024-03-01");
  });

  it("deletes manual rows only", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const manual = createManualTransaction(u.id, acc.id, txInput());
    const imported = seedImportedTransaction(u.id, acc.id);
    deleteTransaction(u.id, manual.id);
    expect(code(() => getTransaction(u.id, manual.id))).toBe("not_found:");
    expect(code(() => deleteTransaction(u.id, imported.id))).toBe("conflict:");
    expect(getTransaction(u.id, imported.id).id).toBe(imported.id);
  });

  it("the (account, externalId) key prevents duplicates across accounts independently", async () => {
    const u = await createTestUser();
    const a1 = seedAccount(u.id);
    const a2 = seedAccount(u.id, { name: "Two" });
    seedImportedTransaction(u.id, a1.id, { externalId: "ref-1" });
    expect(() =>
      seedImportedTransaction(u.id, a1.id, { externalId: "ref-1" }),
    ).toThrow();
    expect(() =>
      seedImportedTransaction(u.id, a2.id, { externalId: "ref-1" }),
    ).not.toThrow();
  });

  it("is invisible and untouchable for other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = seedAccount(a.id);
    const t = createManualTransaction(
      a.id,
      acc.id,
      txInput({ description: "secret" }),
    );

    expect(code(() => listTransactions(b.id, acc.id))).toBe("not_found:");
    expect(code(() => createManualTransaction(b.id, acc.id, txInput()))).toBe(
      "not_found:",
    );
    expect(code(() => getTransaction(b.id, t.id))).toBe("not_found:");
    expect(
      code(() => updateTransaction(b.id, t.id, txInput({ description: "x" }))),
    ).toBe("not_found:");
    expect(code(() => deleteTransaction(b.id, t.id))).toBe("not_found:");
    expect(getTransaction(a.id, t.id).description).toBe("secret");
    expect(listTransactions(a.id, acc.id).total).toBe(1);
  });
});

describe("snapshots", () => {
  useTestDB();

  it("creates, lists newest first and deletes manual snapshots", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const s1 = createSnapshot(u.id, acc.id, {
      date: "2024-01-31",
      amount: minor(10),
      note: null,
    });
    createSnapshot(u.id, acc.id, {
      date: "2024-02-29",
      amount: minor(20),
      note: "n",
    });
    expect(listSnapshots(u.id, acc.id).map((s) => s.date)).toEqual([
      "2024-02-29",
      "2024-01-31",
    ]);
    expect(s1).toMatchObject({ source: "manual", amount: 10 });
    deleteSnapshot(u.id, s1.id);
    expect(listSnapshots(u.id, acc.id)).toHaveLength(1);
  });

  it("allows one manual snapshot per date and keeps imported ones apart", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    createSnapshot(u.id, acc.id, {
      date: "2024-01-31",
      amount: minor(10),
      note: null,
    });
    expect(
      code(() =>
        createSnapshot(u.id, acc.id, {
          date: "2024-01-31",
          amount: minor(11),
          note: null,
        }),
      ),
    ).toBe("conflict:date");
    const imp = seedImport(u.id, acc.id);
    const imported = getDB()
      .insert(balanceSnapshots)
      .values({
        userId: u.id,
        accountId: acc.id,
        importId: imp.id,
        source: "import",
        date: "2024-01-31",
        amount: minor(12),
      })
      .returning()
      .get();
    expect(listSnapshots(u.id, acc.id)).toHaveLength(2);
    expect(code(() => deleteSnapshot(u.id, imported.id))).toBe("conflict:");
  });

  it("deleting an import removes its snapshots and transactions", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const imp = seedImport(u.id, acc.id);
    seedImportedTransaction(u.id, acc.id, { importId: imp.id });
    getDB()
      .insert(balanceSnapshots)
      .values({
        userId: u.id,
        accountId: acc.id,
        importId: imp.id,
        source: "import",
        date: "2024-01-31",
        amount: minor(12),
      })
      .run();
    getDB().delete(imports).where(eq(imports.id, imp.id)).run();
    expect(getDB().select().from(transactions).all()).toHaveLength(0);
    expect(getDB().select().from(balanceSnapshots).all()).toHaveLength(0);
  });

  it("is invisible and untouchable for other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = seedAccount(a.id);
    const s = createSnapshot(a.id, acc.id, {
      date: "2024-01-31",
      amount: minor(10),
      note: null,
    });
    expect(code(() => listSnapshots(b.id, acc.id))).toBe("not_found:");
    expect(
      code(() =>
        createSnapshot(b.id, acc.id, {
          date: "2024-02-01",
          amount: minor(1),
          note: null,
        }),
      ),
    ).toBe("not_found:");
    expect(code(() => getSnapshot(b.id, s.id))).toBe("not_found:");
    expect(code(() => deleteSnapshot(b.id, s.id))).toBe("not_found:");
    expect(listSnapshots(a.id, acc.id)).toHaveLength(1);
  });
});
