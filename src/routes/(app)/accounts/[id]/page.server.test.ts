import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  seedAccount,
  seedImportedTransaction,
  seedInstitution,
} from "$lib/testing/ledger";
import { createCategory } from "$lib/server/categories/categories";
import { getAccount, listAccounts } from "$lib/server/ledger/accounts";
import { createSnapshot, listSnapshots } from "$lib/server/ledger/snapshots";
import {
  createManualTransaction,
  getTransaction,
  listTransactions,
} from "$lib/server/ledger/transactions";
import { updatePreferences } from "$lib/server/preferences";
import { actions, load } from "./+page.server";

type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;
type User = Awaited<ReturnType<typeof createTestUser>>;
const run = (
  name: keyof typeof actions,
  user: User,
  accountId: string,
  form: Record<string, string> = {},
) =>
  outcome(() =>
    actions[name]!(
      createTestEvent({ user, params: { id: accountId }, form }) as never,
    ),
  );
const loadAs = (user: User, accountId: string, query = "") =>
  outcome(() =>
    load(
      createTestEvent({
        user,
        params: { id: accountId },
        url: `http://localhost/accounts/${accountId}${query}`,
      }) as never,
    ),
  );

const manualTx = (userId: string, accountId: string, description = "coffee") =>
  createManualTransaction(userId, accountId, {
    bookingDate: "2024-03-01",
    valueDate: null,
    amount: minor(-450),
    counterpartyName: null,
    counterpartyIban: null,
    description,
    reference: null,
    note: null,
  });

describe("account detail page", () => {
  useTestDB();

  it("load returns account, balance, transactions, snapshots and filters", async () => {
    const u = await createTestUser();
    const inst = seedInstitution(u.id);
    const acc = seedAccount(u.id, { openingBalance: minor(1000) });
    manualTx(u.id, acc.id, "coffee beans");
    manualTx(u.id, acc.id, "rent");
    createSnapshot(u.id, acc.id, {
      date: "2024-01-01",
      amount: minor(5),
      note: null,
    });

    const r = await loadAs(u, acc.id, "?q=coffee&min=abc&pageSize=10");
    expect(r.type).toBe("return");
    const v = (r as { value: LoadData }).value;
    expect(Object.keys(v).sort()).toEqual([
      "account",
      "balance",
      "categories",
      "filterErrors",
      "filters",
      "institutions",
      "snapshots",
      "transactions",
    ]);
    expect(v.account.id).toBe(acc.id);
    expect(v.balance).toBe(v.account.balance);
    expect(v.balance).toBe(5 - 900);
    expect(v.institutions).toEqual([{ id: inst.id, name: "Test Institution" }]);
    expect(v.transactions).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 10,
      pageCount: 1,
    });
    expect(v.transactions.items[0].description).toBe("coffee beans");
    expect(v.snapshots).toHaveLength(1);
    expect(v.filters).toEqual({
      from: "",
      to: "",
      q: "coffee",
      min: "abc",
      max: "",
    });
    expect(Object.keys(v.filterErrors)).toEqual(["min"]);
  });

  it("page size defaults to the user's preference unless the query sets one", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = seedAccount(u.id);
    updatePreferences(u.id, { pageSize: 25 });
    updatePreferences(other.id, { pageSize: 200 });
    const size = async (query = "") =>
      ((await loadAs(u, acc.id, query)) as { value: LoadData }).value
        .transactions.pageSize;
    expect(await size()).toBe(25);
    expect(await size("?pageSize=10")).toBe(10);
  });

  it("404 for unknown accounts", async () => {
    const u = await createTestUser();
    expect(await loadAs(u, "nope")).toEqual({ type: "error", status: 404 });
  });

  it("updates, archives, unarchives and deletes the account", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    expect(
      await run("updateAccount", u, acc.id, {
        name: "Renamed",
        type: "savings",
        currency: "CHF",
        openingBalance: "12.30",
      }),
    ).toMatchObject({
      type: "return",
      value: { success: true, action: "updateAccount" },
    });
    expect(getAccount(u.id, acc.id)).toMatchObject({
      name: "Renamed",
      type: "savings",
      openingBalance: 1230,
    });

    await run("archive", u, acc.id);
    expect(getAccount(u.id, acc.id).archived).toBe(true);
    await run("unarchive", u, acc.id);
    expect(getAccount(u.id, acc.id).archived).toBe(false);

    expect(await run("deleteAccount", u, acc.id)).toEqual({
      type: "redirect",
      status: 303,
      location: "/accounts",
    });
    expect(listAccounts(u.id)).toEqual([]);
  });

  it("updateAccount validation failure echoes values", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const r = await run("updateAccount", u, acc.id, {
      name: "",
      type: "current",
      currency: "CHF",
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "updateAccount",
        errors: { name: ["Name is required."] },
        values: { name: "", type: "current", currency: "CHF" },
      },
    });
  });

  it("adds, edits and deletes manual transactions", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const added = await run("addTransaction", u, acc.id, {
      bookingDate: "2024-03-01",
      amount: "-12.50",
      description: "Groceries",
    });
    expect(added).toMatchObject({ type: "return", value: { success: true } });
    const [tx] = listTransactions(u.id, acc.id).items;
    expect(tx).toMatchObject({
      amount: -1250,
      currency: "CHF",
      source: "manual",
    });

    await run("updateTransaction", u, acc.id, {
      transactionId: tx!.id,
      bookingDate: "2024-03-02",
      amount: "-20",
      description: "Groceries 2",
    });
    expect(getTransaction(u.id, tx!.id)).toMatchObject({
      bookingDate: "2024-03-02",
      amount: -2000,
    });

    await run("deleteTransaction", u, acc.id, { transactionId: tx!.id });
    expect(listTransactions(u.id, acc.id).total).toBe(0);
  });

  it("validates transactions: zero amount, bad date", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const r = await run("addTransaction", u, acc.id, {
      bookingDate: "2024-02-30",
      amount: "0",
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: {
          bookingDate: ["Enter a date as YYYY-MM-DD."],
          amount: ["Amount must not be zero."],
        },
        values: { bookingDate: "2024-02-30", amount: "0" },
      },
    });
    expect(listTransactions(u.id, acc.id).total).toBe(0);
  });

  it("imported transactions accept only a note and cannot be deleted", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const imp = seedImportedTransaction(u.id, acc.id, {
      description: "orig",
      amount: minor(-7),
    });
    // Amount is not required for imported rows because only the note is parsed.
    expect(
      await run("updateTransaction", u, acc.id, {
        transactionId: imp.id,
        note: "remember",
        amount: "999",
        description: "changed",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(getTransaction(u.id, imp.id)).toMatchObject({
      note: "remember",
      description: "orig",
      amount: -7,
    });
    expect(
      await run("deleteTransaction", u, acc.id, { transactionId: imp.id }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { form: [expect.any(String)] } },
    });
    expect(getTransaction(u.id, imp.id).id).toBe(imp.id);
  });

  it("adds and deletes snapshots; duplicate date fails", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const form = { date: "2024-01-31", amount: "1500.25", note: "statement" };
    expect(await run("addSnapshot", u, acc.id, form)).toMatchObject({
      type: "return",
      value: { success: true, action: "addSnapshot" },
    });
    expect(listSnapshots(u.id, acc.id)[0]).toMatchObject({
      amount: 150025,
      source: "manual",
    });
    expect(await run("addSnapshot", u, acc.id, form)).toMatchObject({
      type: "fail",
      data: {
        errors: { date: ["A balance is already recorded for this date."] },
      },
    });
    const [snap] = listSnapshots(u.id, acc.id);
    await run("deleteSnapshot", u, acc.id, { snapshotId: snap!.id });
    expect(listSnapshots(u.id, acc.id)).toEqual([]);
  });

  it("rejects ids that belong to a different account of the same user", async () => {
    const u = await createTestUser();
    const one = seedAccount(u.id, { name: "One" });
    const two = seedAccount(u.id, { name: "Two" });
    const tx = manualTx(u.id, two.id);
    const snap = createSnapshot(u.id, two.id, {
      date: "2024-01-01",
      amount: minor(1),
      note: null,
    });
    expect(
      await run("deleteTransaction", u, one.id, { transactionId: tx.id }),
    ).toEqual({
      type: "error",
      status: 404,
    });
    expect(
      await run("deleteSnapshot", u, one.id, { snapshotId: snap.id }),
    ).toEqual({
      type: "error",
      status: 404,
    });
    expect(getTransaction(u.id, tx.id).id).toBe(tx.id);
  });

  it("sets and clears a category, also on imported rows", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const tx = seedImportedTransaction(u.id, acc.id);
    const c = createCategory(u.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    expect(
      await run("setCategory", u, acc.id, {
        transactionId: tx.id,
        categoryId: c.id,
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(getTransaction(u.id, tx.id).categoryId).toBe(c.id);
    await run("setCategory", u, acc.id, {
      transactionId: tx.id,
      categoryId: "",
    });
    expect(getTransaction(u.id, tx.id).categoryId).toBeNull();
  });

  it("setCategory refuses another user's category and transaction", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accA = seedAccount(a.id);
    const accB = seedAccount(b.id);
    const tx = seedImportedTransaction(a.id, accA.id);
    const theirs = createCategory(b.id, {
      name: "Theirs",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    expect(
      await run("setCategory", a, accA.id, {
        transactionId: tx.id,
        categoryId: theirs.id,
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await run("setCategory", b, accB.id, {
        transactionId: tx.id,
        categoryId: theirs.id,
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(getTransaction(a.id, tx.id).categoryId).toBeNull();
  });

  describe("cross-user", () => {
    async function setup() {
      const a = await createTestUser();
      const b = await createTestUser();
      const acc = seedAccount(a.id, { name: "A's account" });
      const tx = manualTx(a.id, acc.id, "secret description");
      const imported = seedImportedTransaction(a.id, acc.id);
      const snap = createSnapshot(a.id, acc.id, {
        date: "2024-01-01",
        amount: minor(77),
        note: null,
      });
      const bAcc = seedAccount(b.id, { name: "B's account" });
      return { a, b, acc, tx, imported, snap, bAcc };
    }

    it("load is 404 and leaks nothing", async () => {
      const { b, acc } = await setup();
      expect(await loadAs(b, acc.id)).toEqual({ type: "error", status: 404 });
    });

    it("every action on A's account is 404 for B and changes nothing", async () => {
      const { a, b, acc, tx, imported, snap } = await setup();
      const attempts: [keyof typeof actions, Record<string, string>][] = [
        ["updateAccount", { name: "x", type: "current", currency: "CHF" }],
        ["archive", {}],
        ["unarchive", {}],
        ["deleteAccount", {}],
        ["addTransaction", { bookingDate: "2024-01-01", amount: "1" }],
        [
          "updateTransaction",
          { transactionId: tx.id, bookingDate: "2024-01-01", amount: "1" },
        ],
        ["updateTransaction", { transactionId: imported.id, note: "x" }],
        ["deleteTransaction", { transactionId: tx.id }],
        ["addSnapshot", { date: "2024-02-01", amount: "1" }],
        ["deleteSnapshot", { snapshotId: snap.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, b, acc.id, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(getAccount(a.id, acc.id)).toMatchObject({
        name: "A's account",
        archived: false,
      });
      expect(listTransactions(a.id, acc.id).total).toBe(2);
      expect(getTransaction(a.id, tx.id).description).toBe(
        "secret description",
      );
      expect(getTransaction(a.id, tx.id).taxYear).toBeNull();
      expect(getTransaction(a.id, imported.id).note).toBeNull();
      expect(listSnapshots(a.id, acc.id)).toHaveLength(1);
    });

    it("A's ids used through B's own account are 404 too", async () => {
      const { a, b, tx, imported, snap, bAcc } = await setup();
      const attempts: [keyof typeof actions, Record<string, string>][] = [
        [
          "updateTransaction",
          { transactionId: tx.id, bookingDate: "2024-01-01", amount: "1" },
        ],
        ["updateTransaction", { transactionId: imported.id, note: "x" }],
        ["deleteTransaction", { transactionId: tx.id }],
        ["setTaxYear", { transactionId: tx.id, taxYear: "2025" }],
        ["deleteSnapshot", { snapshotId: snap.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, b, bAcc.id, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(getTransaction(a.id, tx.id).description).toBe(
        "secret description",
      );
      expect(listSnapshots(a.id, snap.accountId)).toHaveLength(1);
    });
  });
  it("marks a transaction as a tax payment and clears it again", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    const tx = manualTx(u.id, acc.id);
    expect(
      await run("setTaxYear", u, acc.id, {
        transactionId: tx.id,
        taxYear: "2025",
      }),
    ).toMatchObject({ type: "return" });
    expect(getTransaction(u.id, tx.id).taxYear).toBe(2025);
    expect(
      await run("setTaxYear", u, acc.id, {
        transactionId: tx.id,
        taxYear: "x",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    await run("setTaxYear", u, acc.id, { transactionId: tx.id, taxYear: "" });
    expect(getTransaction(u.id, tx.id).taxYear).toBeNull();
  });
});
