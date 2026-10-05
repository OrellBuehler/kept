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
  transaction,
} from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
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
  getTransactionRowInTx,
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

async function code(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
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
    const inst = await createInstitution(u.id, {
      name: "Beta",
      bic: null,
      color: null,
    });
    await createInstitution(u.id, {
      name: "Alpha",
      bic: "AAAACHZZ",
      color: "#112233",
    });
    await seedAccount(u.id, { institutionId: inst.id });

    expect(
      (await listInstitutions(u.id)).map((i) => [i.name, i.accountCount]),
    ).toEqual([
      ["Alpha", 0],
      ["Beta", 1],
    ]);
    const updated = await updateInstitution(u.id, inst.id, {
      name: "Gamma",
      bic: null,
      color: "#ffffff",
    });
    expect(updated).toMatchObject({ name: "Gamma", color: "#ffffff" });
  });

  it("enforces unique names per user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const first = await seedInstitution(a.id, "Same");
    expect(await code(() => seedInstitution(a.id, "Same"))).toBe(
      "conflict:name",
    );
    await expect(seedInstitution(b.id, "Same")).resolves.not.toThrow();
    const other = await seedInstitution(a.id, "Other");
    expect(
      await code(() =>
        updateInstitution(a.id, other.id, {
          name: "Same",
          bic: null,
          color: null,
        }),
      ),
    ).toBe("conflict:name");
    await expect(
      updateInstitution(a.id, first.id, {
        name: "Same",
        bic: null,
        color: null,
      }),
    ).resolves.not.toThrow();
  });

  it("refuses deletion while accounts reference it", async () => {
    const u = await createTestUser();
    const inst = await seedInstitution(u.id);
    const acc = await seedAccount(u.id, { institutionId: inst.id });
    expect(await code(() => deleteInstitution(u.id, inst.id))).toBe(
      "conflict:",
    );
    await deleteAccount(u.id, acc.id);
    await deleteInstitution(u.id, inst.id);
    expect(await listInstitutions(u.id)).toEqual([]);
  });

  it("is invisible to other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const inst = await seedInstitution(a.id);
    expect(await listInstitutions(b.id)).toEqual([]);
    expect(await code(() => getInstitution(b.id, inst.id))).toBe("not_found:");
    expect(
      await code(() =>
        updateInstitution(b.id, inst.id, {
          name: "x",
          bic: null,
          color: null,
        }),
      ),
    ).toBe("not_found:");
    expect(await code(() => deleteInstitution(b.id, inst.id))).toBe(
      "not_found:",
    );
    expect((await getInstitution(a.id, inst.id)).name).toBe("Test Institution");
  });
});

describe("accounts", () => {
  useTestDB();

  it("creates with defaults and exposes balance, masked IBAN and institution", async () => {
    const u = await createTestUser();
    const inst = await seedInstitution(u.id);
    const acc = await seedAccount(u.id, {
      institutionId: inst.id,
      iban: LEDGER_IBAN_A,
      openingBalance: minor(10000),
    });
    expect(acc).toMatchObject({
      archived: false,
      balance: 10000,
      iban: LEDGER_IBAN_A,
      institution: { id: inst.id, name: "Test Institution", color: null },
      lastBookingDate: null,
      lastImportAt: null,
      sortOrder: 0,
    });
    expect((await seedAccount(u.id, { name: "Second" })).sortOrder).toBe(1);
  });

  it("reports last booking date, last import and current balance in the list", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { openingBalance: minor(100) });
    await seedImportedTransaction(u.id, acc.id, {
      bookingDate: "2024-02-01",
      amount: minor(-30),
    });
    await seedImportedTransaction(u.id, acc.id, {
      bookingDate: "2024-03-01",
      amount: minor(5),
    });
    const imp = await seedImport(u.id, acc.id);
    const [listed] = await listAccounts(u.id);
    expect(listed).toMatchObject({
      balance: 75,
      lastBookingDate: "2024-03-01",
      lastImportAt: imp.createdAt.getTime(),
    });
  });

  it("orders by sortOrder then name", async () => {
    const u = await createTestUser();
    await seedAccount(u.id, { name: "B", sortOrder: 1 });
    await seedAccount(u.id, { name: "A", sortOrder: 1 });
    await seedAccount(u.id, { name: "Z", sortOrder: 0 });
    expect((await listAccounts(u.id)).map((a) => a.name)).toEqual([
      "Z",
      "A",
      "B",
    ]);
  });

  it("stores notice fields and clears them on update", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id, {
      type: "savings",
      noticeMonths: 6,
      freeWithdrawal: minor(2500000),
      freeWithdrawalPeriod: "year",
    });
    expect(await getAccount(u.id, a.id)).toMatchObject({
      noticeMonths: 6,
      freeWithdrawal: 2500000,
      freeWithdrawalPeriod: "year",
    });
    const cleared = await updateAccount(u.id, a.id, {
      ...accountToInput(a),
      noticeMonths: null,
      freeWithdrawal: null,
      freeWithdrawalPeriod: null,
    });
    expect(cleared).toMatchObject({
      noticeMonths: null,
      freeWithdrawal: null,
      freeWithdrawalPeriod: null,
    });
  });

  it("enforces a unique IBAN per user, but allows several without one", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedAccount(a.id, { iban: LEDGER_IBAN_A });
    expect(await code(() => seedAccount(a.id, { iban: LEDGER_IBAN_A }))).toBe(
      "conflict:iban",
    );
    await expect(
      seedAccount(b.id, { iban: LEDGER_IBAN_A }),
    ).resolves.not.toThrow();
    await expect(seedAccount(a.id, { name: "n1" })).resolves.not.toThrow();
    await expect(seedAccount(a.id, { name: "n2" })).resolves.not.toThrow();
    const other = await seedAccount(a.id, { iban: LEDGER_IBAN_B });
    expect(
      await code(() =>
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
    const inst = await seedInstitution(a.id);
    expect(
      await code(() => seedAccount(b.id, { institutionId: inst.id })),
    ).toBe("invalid:institutionId");
  });

  it("updates, and blocks currency changes once data exists", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const renamed = await updateAccount(u.id, acc.id, {
      ...accountToInput(acc),
      name: "Renamed",
      currency: "EUR",
    });
    expect(renamed).toMatchObject({ name: "Renamed", currency: "EUR" });
    await seedImportedTransaction(u.id, acc.id, { currency: "EUR" });
    expect(
      await code(() =>
        updateAccount(u.id, acc.id, {
          ...accountToInput(renamed),
          currency: "CHF",
        }),
      ),
    ).toBe("conflict:currency");
    expect(
      (
        await updateAccount(u.id, acc.id, {
          ...accountToInput(renamed),
          sortOrder: null,
        })
      ).sortOrder,
    ).toBe(renamed.sortOrder);
  });

  it("blocks a currency change while the opening balance is not zero", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { openingBalance: minor(50000) });
    expect(
      await code(() =>
        updateAccount(u.id, acc.id, {
          ...accountToInput(acc),
          currency: "EUR",
        }),
      ),
    ).toBe("conflict:currency");
    expect((await getAccount(u.id, acc.id)).currency).toBe("CHF");
    const cleared = await updateAccount(u.id, acc.id, {
      ...accountToInput(acc),
      openingBalance: minor(0),
    });
    expect(
      (
        await updateAccount(u.id, acc.id, {
          ...accountToInput(cleared),
          currency: "EUR",
        })
      ).currency,
    ).toBe("EUR");
  });

  it("archives and unarchives", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    expect((await archiveAccount(u.id, acc.id)).archived).toBe(true);
    expect((await listAccounts(u.id))[0]!.archived).toBe(true);
    expect((await unarchiveAccount(u.id, acc.id)).archived).toBe(false);
  });

  it("hard delete cascades to transactions, imports, snapshots and profiles", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const keep = await seedAccount(u.id, { name: "Keep" });
    const imp = await seedImport(u.id, acc.id);
    await seedImportedTransaction(u.id, acc.id, { importId: imp.id });
    await seedImportedTransaction(u.id, keep.id);
    await createManualTransaction(u.id, acc.id, txInput());
    await createSnapshot(u.id, acc.id, {
      date: "2024-01-01",
      amount: minor(1),
      note: null,
    });
    await getDB()
      .insert(csvProfiles)
      .values({ userId: u.id, accountId: acc.id, name: "p", profile: "{}" });

    await deleteAccount(u.id, acc.id);

    const db = getDB();
    expect(await db.select().from(transactions)).toHaveLength(1);
    expect(await db.select().from(imports)).toHaveLength(0);
    expect(await db.select().from(balanceSnapshots)).toHaveLength(0);
    expect(await db.select().from(csvProfiles)).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(1);
  });

  it("is invisible and untouchable for other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id, { iban: LEDGER_IBAN_A });
    expect(await listAccounts(b.id)).toEqual([]);
    expect(await code(() => getAccount(b.id, acc.id))).toBe("not_found:");
    expect(
      await code(() =>
        updateAccount(b.id, acc.id, {
          ...accountToInput(acc),
          name: "x",
        }),
      ),
    ).toBe("not_found:");
    expect(await code(() => archiveAccount(b.id, acc.id))).toBe("not_found:");
    expect(await code(() => unarchiveAccount(b.id, acc.id))).toBe("not_found:");
    expect(await code(() => deleteAccount(b.id, acc.id))).toBe("not_found:");
    expect(await getAccount(a.id, acc.id)).toMatchObject({
      name: "Main",
      archived: false,
    });
  });
});

function accountToInput(a: Awaited<ReturnType<typeof getAccount>>) {
  return {
    institutionId: a.institution?.id ?? null,
    name: a.name,
    type: a.type,
    currency: a.currency,
    iban: a.iban,
    contractNumber: a.contractNumber,
    depositIban: a.depositIban,
    openingBalance: a.openingBalance,
    openingDate: a.openingDate,
    noticeMonths: a.noticeMonths,
    freeWithdrawal: a.freeWithdrawal,
    freeWithdrawalPeriod: a.freeWithdrawalPeriod,
    fillFromTransfers: a.fillFromTransfers,
    tradesMoveCash: a.tradesMoveCash,
    shareBps: a.shareBps,
    sharedWith: a.sharedWith,
    sortOrder: a.sortOrder,
  };
}

describe("transactions", () => {
  useTestDB();

  it("creates manual rows in the account currency with a manual external id", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { currency: "EUR" });
    const t = await createManualTransaction(
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
    const acc = await seedAccount(u.id);
    for (let day = 1; day <= 7; day++) {
      await createManualTransaction(
        u.id,
        acc.id,
        txInput({ bookingDate: `2024-03-0${day}`, amount: minor(day) }),
      );
    }
    const p1 = await listTransactions(u.id, acc.id, { pageSize: 3 });
    expect(p1).toMatchObject({ total: 7, page: 1, pageSize: 3, pageCount: 3 });
    expect(p1.items.map((t) => t.bookingDate)).toEqual([
      "2024-03-07",
      "2024-03-06",
      "2024-03-05",
    ]);
    const p3 = await listTransactions(u.id, acc.id, { pageSize: 3, page: 3 });
    expect(p3.items.map((t) => t.bookingDate)).toEqual(["2024-03-01"]);
    expect(
      (await listTransactions(u.id, acc.id, { pageSize: 3, page: 99 })).page,
    ).toBe(3);
  });

  it("orders rows of the same day newest-inserted first", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    for (const amount of [1, 2, 3]) {
      await createManualTransaction(
        u.id,
        acc.id,
        txInput({ amount: minor(amount) }),
      );
    }
    expect(
      (await listTransactions(u.id, acc.id)).items.map((t) => t.amount),
    ).toEqual([3, 2, 1]);
  });

  it("filters by date range, amount range and text", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    await createManualTransaction(
      u.id,
      acc.id,
      txInput({
        bookingDate: "2024-01-10",
        amount: minor(-2000),
        description: "Rent January",
      }),
    );
    await createManualTransaction(
      u.id,
      acc.id,
      txInput({
        bookingDate: "2024-02-10",
        amount: minor(-150),
        counterpartyName: "Corner Shop",
      }),
    );
    await createManualTransaction(
      u.id,
      acc.id,
      txInput({
        bookingDate: "2024-03-10",
        amount: minor(300),
        description: "100% refund_x",
      }),
    );
    const ids = async (filters: Parameters<typeof listTransactions>[2]) =>
      (await listTransactions(u.id, acc.id, filters)).items.map(
        (t) => t.bookingDate,
      );

    expect(await ids({ filters: { from: "2024-02-01" } })).toEqual([
      "2024-03-10",
      "2024-02-10",
    ]);
    expect(await ids({ filters: { to: "2024-02-10" } })).toEqual([
      "2024-02-10",
      "2024-01-10",
    ]);
    expect(
      await ids({ filters: { from: "2024-02-10", to: "2024-02-10" } }),
    ).toEqual(["2024-02-10"]);
    expect(await ids({ filters: { minAmount: minor(-200) } })).toEqual([
      "2024-03-10",
      "2024-02-10",
    ]);
    expect(await ids({ filters: { maxAmount: minor(-200) } })).toEqual([
      "2024-01-10",
    ]);
    expect(await ids({ filters: { q: "rent" } })).toEqual(["2024-01-10"]);
    expect(await ids({ filters: { q: "corner" } })).toEqual(["2024-02-10"]);
    expect(await ids({ filters: { q: "100%" } })).toEqual(["2024-03-10"]);
    expect(await ids({ filters: { q: "%" } })).toEqual(["2024-03-10"]);
    expect(await ids({ filters: { q: "_x" } })).toEqual(["2024-03-10"]);
    expect(await ids({ filters: { q: "nothing" } })).toEqual([]);
    expect(
      await listTransactions(u.id, acc.id, { filters: { q: "nothing" } }),
    ).toMatchObject({ total: 0, page: 1, pageCount: 1 });
  });

  it("manual rows are fully editable, imported rows only take a note", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const manual = await createManualTransaction(u.id, acc.id, txInput());
    const edited = await updateTransaction(
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

    const imported = await seedImportedTransaction(u.id, acc.id, {
      description: "Original",
      amount: minor(-1234),
    });
    const noted = await updateTransaction(u.id, imported.id, {
      note: "my note",
    });
    expect(noted).toMatchObject({
      note: "my note",
      description: "Original",
      amount: -1234,
    });
    // Even a full payload must not change imported data.
    const again = await updateTransaction(
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
    const acc = await seedAccount(u.id, { openingDate: "2024-03-01" });
    expect(
      await code(() =>
        createManualTransaction(
          u.id,
          acc.id,
          txInput({ bookingDate: "2024-02-29" }),
        ),
      ),
    ).toBe("invalid:bookingDate");
    const ok = await createManualTransaction(
      u.id,
      acc.id,
      txInput({ bookingDate: "2024-03-01" }),
    );
    expect(
      await code(() =>
        updateTransaction(u.id, ok.id, txInput({ bookingDate: "2024-01-01" })),
      ),
    ).toBe("invalid:bookingDate");
    expect((await getTransaction(u.id, ok.id)).bookingDate).toBe("2024-03-01");
  });

  it("deletes manual rows only", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const manual = await createManualTransaction(u.id, acc.id, txInput());
    const imported = await seedImportedTransaction(u.id, acc.id);
    await deleteTransaction(u.id, manual.id);
    expect(await code(() => getTransaction(u.id, manual.id))).toBe(
      "not_found:",
    );
    expect(await code(() => deleteTransaction(u.id, imported.id))).toBe(
      "conflict:",
    );
    expect((await getTransaction(u.id, imported.id)).id).toBe(imported.id);
  });

  it("the (account, externalId) key prevents duplicates across accounts independently", async () => {
    const u = await createTestUser();
    const a1 = await seedAccount(u.id);
    const a2 = await seedAccount(u.id, { name: "Two" });
    await seedImportedTransaction(u.id, a1.id, { externalId: "ref-1" });
    await expect(
      seedImportedTransaction(u.id, a1.id, { externalId: "ref-1" }),
    ).rejects.toThrow();
    await expect(
      seedImportedTransaction(u.id, a2.id, { externalId: "ref-1" }),
    ).resolves.not.toThrow();
  });

  it("is invisible and untouchable for other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const t = await createManualTransaction(
      a.id,
      acc.id,
      txInput({ description: "secret" }),
    );

    expect(await code(() => listTransactions(b.id, acc.id))).toBe("not_found:");
    expect(
      await code(() => createManualTransaction(b.id, acc.id, txInput())),
    ).toBe("not_found:");
    expect(await code(() => getTransaction(b.id, t.id))).toBe("not_found:");
    expect(
      await code(() =>
        updateTransaction(b.id, t.id, txInput({ description: "x" })),
      ),
    ).toBe("not_found:");
    expect(await code(() => deleteTransaction(b.id, t.id))).toBe("not_found:");
    expect((await getTransaction(a.id, t.id)).description).toBe("secret");
    expect((await listTransactions(a.id, acc.id)).total).toBe(1);
  });
});

describe("snapshots", () => {
  useTestDB();

  it("creates, lists newest first and deletes manual snapshots", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const s1 = await createSnapshot(u.id, acc.id, {
      date: "2024-01-31",
      amount: minor(10),
      note: null,
    });
    await createSnapshot(u.id, acc.id, {
      date: "2024-02-29",
      amount: minor(20),
      note: "n",
    });
    expect((await listSnapshots(u.id, acc.id)).map((s) => s.date)).toEqual([
      "2024-02-29",
      "2024-01-31",
    ]);
    expect(s1).toMatchObject({ source: "manual", amount: 10 });
    await deleteSnapshot(u.id, s1.id);
    expect(await listSnapshots(u.id, acc.id)).toHaveLength(1);
  });

  it("allows one manual snapshot per date and keeps imported ones apart", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    await createSnapshot(u.id, acc.id, {
      date: "2024-01-31",
      amount: minor(10),
      note: null,
    });
    expect(
      await code(() =>
        createSnapshot(u.id, acc.id, {
          date: "2024-01-31",
          amount: minor(11),
          note: null,
        }),
      ),
    ).toBe("conflict:date");
    const imp = await seedImport(u.id, acc.id);
    const imported = (
      await getDB()
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
    )[0]!;
    expect(await listSnapshots(u.id, acc.id)).toHaveLength(2);
    expect(await code(() => deleteSnapshot(u.id, imported.id))).toBe(
      "conflict:",
    );
  });

  it("deleting an import removes its snapshots and transactions", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const imp = await seedImport(u.id, acc.id);
    await seedImportedTransaction(u.id, acc.id, { importId: imp.id });
    await getDB()
      .insert(balanceSnapshots)
      .values({
        userId: u.id,
        accountId: acc.id,
        importId: imp.id,
        source: "import",
        date: "2024-01-31",
        amount: minor(12),
      });
    await getDB().delete(imports).where(eq(imports.id, imp.id));
    expect(await getDB().select().from(transactions)).toHaveLength(0);
    expect(await getDB().select().from(balanceSnapshots)).toHaveLength(0);
  });

  it("is invisible and untouchable for other users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const s = await createSnapshot(a.id, acc.id, {
      date: "2024-01-31",
      amount: minor(10),
      note: null,
    });
    expect(await code(() => listSnapshots(b.id, acc.id))).toBe("not_found:");
    expect(
      await code(() =>
        createSnapshot(b.id, acc.id, {
          date: "2024-02-01",
          amount: minor(1),
          note: null,
        }),
      ),
    ).toBe("not_found:");
    expect(await code(() => getSnapshot(b.id, s.id))).toBe("not_found:");
    expect(await code(() => deleteSnapshot(b.id, s.id))).toBe("not_found:");
    expect(await listSnapshots(a.id, acc.id)).toHaveLength(1);
  });
});

describe("checks and writes share a transaction", () => {
  useTestDB();

  it("changes nothing when an account update is refused", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { openingBalance: minor(50000) });
    expect(
      await code(() =>
        updateAccount(u.id, acc.id, {
          ...accountToInput(acc),
          name: "Renamed",
          currency: "EUR",
        }),
      ),
    ).toBe("conflict:currency");
    expect(await getAccount(u.id, acc.id)).toMatchObject({
      name: "Main",
      currency: "CHF",
    });
  });

  it("creates no account when the IBAN is taken, and leaves the sort order alone", async () => {
    const u = await createTestUser();
    await seedAccount(u.id, { iban: LEDGER_IBAN_A });
    expect(
      await code(() => seedAccount(u.id, { name: "Dup", iban: LEDGER_IBAN_A })),
    ).toBe("conflict:iban");
    expect(await listAccounts(u.id)).toHaveLength(1);
    expect((await seedAccount(u.id, { name: "Next" })).sortOrder).toBe(1);
  });

  it("appends the sort order per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedAccount(a.id, { name: "A1" });
    await seedAccount(a.id, { name: "A2" });
    expect((await seedAccount(b.id, { name: "B1" })).sortOrder).toBe(0);
    expect((await seedAccount(a.id, { name: "A3" })).sortOrder).toBe(2);
  });

  it("reports an update of another user's account as not found, whatever else is wrong", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    expect(
      await code(() =>
        updateAccount(b.id, acc.id, {
          ...accountToInput(acc),
          institutionId: "missing",
        }),
      ),
    ).toBe("not_found:");
  });

  it("allows one manual and one imported balance per date, but not two manual ones", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const imp = await seedImport(u.id, acc.id);
    await getDB()
      .insert(balanceSnapshots)
      .values({
        userId: u.id,
        accountId: acc.id,
        importId: imp.id,
        source: "import",
        date: "2024-03-01",
        amount: minor(100),
      });
    await createSnapshot(u.id, acc.id, {
      date: "2024-03-01",
      amount: minor(200),
      note: null,
    });
    expect(
      await code(() =>
        createSnapshot(u.id, acc.id, {
          date: "2024-03-01",
          amount: minor(300),
          note: null,
        }),
      ),
    ).toBe("conflict:date");
    expect(await listSnapshots(u.id, acc.id)).toHaveLength(2);
  });

  it("rejects a duplicate institution name through the unique index", async () => {
    const u = await createTestUser();
    await seedInstitution(u.id, "Same");
    expect(await code(() => seedInstitution(u.id, "Same"))).toBe(
      "conflict:name",
    );
    expect(await listInstitutions(u.id)).toHaveLength(1);
  });

  it("deletes an institution only while no account uses it, atomically", async () => {
    const u = await createTestUser();
    const inst = await seedInstitution(u.id);
    const acc = await seedAccount(u.id, { institutionId: inst.id });
    expect(await code(() => deleteInstitution(u.id, inst.id))).toBe(
      "conflict:",
    );
    expect(await getInstitution(u.id, inst.id)).toMatchObject({
      accountCount: 1,
    });
    await deleteAccount(u.id, acc.id);
    await deleteInstitution(u.id, inst.id);
    expect(await listInstitutions(u.id)).toEqual([]);
  });

  it("getTransactionRowInTx reads the plain row inside a transaction, for its owner only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = await seedAccount(u.id);
    const row = await seedImportedTransaction(u.id, acc.id, {
      amount: minor(-1234),
      description: "Example",
    });
    const view = await getTransaction(u.id, row.id);
    const plain = await transaction(async (tx) =>
      getTransactionRowInTx(tx, u.id, row.id),
    );
    const expected: Record<string, unknown> = { ...view };
    delete expected.mirrorOf;
    delete expected.transfer;
    expect(plain).toMatchObject(expected);
    await expect(
      transaction(async (tx) => getTransactionRowInTx(tx, other.id, row.id)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      transaction(async (tx) => getTransactionRowInTx(tx, u.id, "missing")),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
