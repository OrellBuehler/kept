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
import { seedSecurity, seedTrade } from "$lib/testing/investments";
import { listTrades } from "$lib/server/investments";
import { createSnapshot, listSnapshots } from "$lib/server/ledger/snapshots";
import {
  createManualTransaction,
  getTransaction,
  listTransactions,
} from "$lib/server/ledger/transactions";
import {
  getPortfolio,
  listPortfolios,
  listValues,
  setValues,
} from "$lib/server/pillar3a";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { updatePreferences } from "$lib/server/preferences";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { getDB, transactions as transactionsTable } from "$lib/server/db";
import { eq } from "drizzle-orm";
import { linkTransfers, listNeedsAmount } from "$lib/server/transfers";
import { createLink } from "$lib/server/external-api/links";
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

const manualTx = async (
  userId: string,
  accountId: string,
  description = "coffee",
) =>
  await createManualTransaction(userId, accountId, {
    bookingDate: "2024-03-01",
    valueDate: null,
    amount: minor(-450),
    counterpartyName: null,
    counterpartyIban: null,
    description,
    reference: null,
    note: null,
  });

const tradeForm = (securityId: string): Record<string, string> => ({
  securityId,
  date: "2024-02-01",
  side: "buy",
  quantity: "2",
  price: "50",
  fees: "1",
  amount: "101",
});

describe("account detail page", () => {
  useTestDB();

  it("breaks the value of investment accounts into cash and holdings", async () => {
    const u = await createTestUser();
    const plain = await seedAccount(u.id);
    const inv = await seedAccount(u.id, {
      type: "investment",
      openingBalance: minor(500),
    });
    const sec = await seedSecurity(u.id);
    await seedTrade(u.id, inv.id, sec.id, {
      qty: "2",
      price: "50",
      amount: 10000,
    });

    const plainData = ((await loadAs(u, plain.id)) as { value: LoadData })
      .value;
    expect(plainData.value).toBeNull();
    expect(plainData.trades).toEqual([]);

    const v = ((await loadAs(u, inv.id)) as { value: LoadData }).value;
    expect(v.value).toMatchObject({ cash: 500, holdings: 10000, total: 10500 });
    expect(v.value!.positions).toHaveLength(1);
    expect(v.balance).toBe(10500);
    expect(v.securities.map((s: { id: string }) => s.id)).toEqual([sec.id]);
    expect(v.trades).toHaveLength(1);
  });

  it("adds, edits and deletes trades", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { type: "investment" });
    const sec = await seedSecurity(u.id);

    const added = await run("addTrade", u, acc.id, tradeForm(sec.id));
    expect(added).toMatchObject({
      type: "return",
      value: { success: true, action: "addTrade" },
    });
    const [trade] = await listTrades(u.id, acc.id);
    expect(trade).toMatchObject({ amount: 10100, fees: 100, side: "buy" });

    expect(
      await run("updateTrade", u, acc.id, {
        tradeId: trade!.id,
        ...tradeForm(sec.id),
        quantity: "3",
        amount: "151",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect((await listTrades(u.id, acc.id))[0]).toMatchObject({
      quantity: 300_000_000,
      amount: 15100,
    });

    expect(
      await run("deleteTrade", u, acc.id, { tradeId: trade!.id }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(await listTrades(u.id, acc.id)).toEqual([]);
  });

  it("validates trades and echoes the values", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { type: "investment" });
    const sec = await seedSecurity(u.id);
    const r = await run("addTrade", u, acc.id, {
      ...tradeForm(sec.id),
      quantity: "0",
      amount: "abc",
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: { action: "addTrade", values: { quantity: "0", amount: "abc" } },
    });
    const errors = (r as { data: { errors: object } }).data.errors;
    expect(Object.keys(errors).sort()).toEqual(["amount", "quantity"]);
    expect(await listTrades(u.id, acc.id)).toEqual([]);
  });

  it("refuses a sell that would leave a negative holding and a trade in another user's security", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = await seedAccount(u.id, { type: "investment" });
    const sec = await seedSecurity(u.id);
    const foreign = await seedSecurity(other.id);
    const sell = await run("addTrade", u, acc.id, {
      ...tradeForm(sec.id),
      side: "sell",
    });
    expect(sell).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { quantity: [expect.any(String)] } },
    });
    expect(await run("addTrade", u, acc.id, tradeForm(foreign.id))).toEqual({
      type: "error",
      status: 404,
    });
    expect(await listTrades(u.id, acc.id)).toEqual([]);
  });

  it("locks the account currency once it has trades", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, {
      type: "investment",
      currency: "CHF",
    });
    const sec = await seedSecurity(u.id);
    await seedTrade(u.id, acc.id, sec.id, { amount: 100000 });
    const r = await run("updateAccount", u, acc.id, {
      name: "x",
      type: "investment",
      currency: "EUR",
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { currency: [expect.any(String)] } },
    });
    expect((await getAccount(u.id, acc.id)).currency).toBe("CHF");
  });

  it("load returns account, balance, transactions, snapshots and filters", async () => {
    const u = await createTestUser();
    const inst = await seedInstitution(u.id);
    const acc = await seedAccount(u.id, { openingBalance: minor(1000) });
    await manualTx(u.id, acc.id, "coffee beans");
    await manualTx(u.id, acc.id, "rent");
    await createSnapshot(u.id, acc.id, {
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
      "focused",
      "hasHoldings",
      "institutions",
      "portfolioValues",
      "portfolios",
      "securities",
      "showPortfolios",
      "snapshots",
      "trades",
      "transactionLinks",
      "transactions",
      "transfers",
      "value",
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
    const acc = await seedAccount(u.id);
    await updatePreferences(u.id, { pageSize: 25 });
    await updatePreferences(other.id, { pageSize: 200 });
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
    const acc = await seedAccount(u.id);
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
    expect(await getAccount(u.id, acc.id)).toMatchObject({
      name: "Renamed",
      type: "savings",
      openingBalance: 1230,
    });

    await run("archive", u, acc.id);
    expect((await getAccount(u.id, acc.id)).archived).toBe(true);
    await run("unarchive", u, acc.id);
    expect((await getAccount(u.id, acc.id)).archived).toBe(false);

    expect(await run("deleteAccount", u, acc.id)).toEqual({
      type: "redirect",
      status: 303,
      location: "/accounts",
    });
    expect(await listAccounts(u.id)).toEqual([]);
  });

  it("updateAccount turns filling off only when the form says the field was shown", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, {
      type: "savings",
      fillFromTransfers: true,
    });
    const form = { name: "Main", type: "savings", currency: "CHF" };
    await run("updateAccount", u, acc.id, form);
    expect((await getAccount(u.id, acc.id)).fillFromTransfers).toBe(true);
    await run("updateAccount", u, acc.id, {
      ...form,
      fillFromTransfersField: "1",
      fillFromTransfers: "on",
    });
    expect((await getAccount(u.id, acc.id)).fillFromTransfers).toBe(true);
    await run("updateAccount", u, acc.id, {
      ...form,
      fillFromTransfersField: "1",
    });
    expect((await getAccount(u.id, acc.id)).fillFromTransfers).toBe(false);
    await run("updateAccount", u, acc.id, form);
    expect((await getAccount(u.id, acc.id)).fillFromTransfers).toBe(false);
  });

  it("updateAccount validation failure echoes values", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
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
    const acc = await seedAccount(u.id);
    const added = await run("addTransaction", u, acc.id, {
      bookingDate: "2024-03-01",
      amount: "-12.50",
      description: "Groceries",
    });
    expect(added).toMatchObject({ type: "return", value: { success: true } });
    const [tx] = (await listTransactions(u.id, acc.id)).items;
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
    expect(await getTransaction(u.id, tx!.id)).toMatchObject({
      bookingDate: "2024-03-02",
      amount: -2000,
    });

    await run("deleteTransaction", u, acc.id, { transactionId: tx!.id });
    expect((await listTransactions(u.id, acc.id)).total).toBe(0);
  });

  it("validates transactions: zero amount, bad date", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
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
    expect((await listTransactions(u.id, acc.id)).total).toBe(0);
  });

  it("imported transactions accept only a note and cannot be deleted", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const imp = await seedImportedTransaction(u.id, acc.id, {
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
    expect(await getTransaction(u.id, imp.id)).toMatchObject({
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
    expect((await getTransaction(u.id, imp.id)).id).toBe(imp.id);
  });

  it("adds and deletes snapshots; duplicate date fails", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const form = { date: "2024-01-31", amount: "1500.25", note: "statement" };
    expect(await run("addSnapshot", u, acc.id, form)).toMatchObject({
      type: "return",
      value: { success: true, action: "addSnapshot" },
    });
    expect((await listSnapshots(u.id, acc.id))[0]).toMatchObject({
      amount: 150025,
      source: "manual",
    });
    expect(await run("addSnapshot", u, acc.id, form)).toMatchObject({
      type: "fail",
      data: {
        errors: { date: ["A balance is already recorded for this date."] },
      },
    });
    const [snap] = await listSnapshots(u.id, acc.id);
    await run("deleteSnapshot", u, acc.id, { snapshotId: snap!.id });
    expect(await listSnapshots(u.id, acc.id)).toEqual([]);
  });

  it("rejects ids that belong to a different account of the same user", async () => {
    const u = await createTestUser();
    const one = await seedAccount(u.id, { name: "One" });
    const two = await seedAccount(u.id, { name: "Two" });
    const tx = await manualTx(u.id, two.id);
    const snap = await createSnapshot(u.id, two.id, {
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
    expect((await getTransaction(u.id, tx.id)).id).toBe(tx.id);
  });

  it("sets and clears a category, also on imported rows", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const tx = await seedImportedTransaction(u.id, acc.id);
    const c = await createCategory(u.id, {
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
    expect((await getTransaction(u.id, tx.id)).categoryId).toBe(c.id);
    await run("setCategory", u, acc.id, {
      transactionId: tx.id,
      categoryId: "",
    });
    expect((await getTransaction(u.id, tx.id)).categoryId).toBeNull();
  });

  it("setCategory refuses another user's category and transaction", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accA = await seedAccount(a.id);
    const accB = await seedAccount(b.id);
    const tx = await seedImportedTransaction(a.id, accA.id);
    const theirs = await createCategory(b.id, {
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
    expect((await getTransaction(a.id, tx.id)).categoryId).toBeNull();
  });

  describe("cross-user", () => {
    async function setup() {
      const a = await createTestUser();
      const b = await createTestUser();
      const acc = await seedAccount(a.id, { name: "A's account" });
      const tx = await manualTx(a.id, acc.id, "secret description");
      const imported = await seedImportedTransaction(a.id, acc.id);
      const snap = await createSnapshot(a.id, acc.id, {
        date: "2024-01-01",
        amount: minor(77),
        note: null,
      });
      const bAcc = await seedAccount(b.id, { name: "B's account" });
      const sec = await seedSecurity(a.id);
      const trade = await seedTrade(a.id, acc.id, sec.id, { amount: 100000 });
      return { a, b, acc, tx, imported, snap, bAcc, sec, trade };
    }

    it("load is 404 and leaks nothing", async () => {
      const { b, acc } = await setup();
      expect(await loadAs(b, acc.id)).toEqual({ type: "error", status: 404 });
    });

    it("every action on A's account is 404 for B and changes nothing", async () => {
      const { a, b, acc, tx, imported, snap, sec, trade } = await setup();
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
        ["addTrade", tradeForm(sec.id)],
        ["updateTrade", { tradeId: trade.id, ...tradeForm(sec.id) }],
        ["deleteTrade", { tradeId: trade.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, b, acc.id, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(await getAccount(a.id, acc.id)).toMatchObject({
        name: "A's account",
        archived: false,
      });
      expect((await listTransactions(a.id, acc.id)).total).toBe(2);
      expect((await getTransaction(a.id, tx.id)).description).toBe(
        "secret description",
      );
      expect((await getTransaction(a.id, tx.id)).taxYear).toBeNull();
      expect((await getTransaction(a.id, tx.id)).deductionYear).toBeNull();
      expect((await getTransaction(a.id, imported.id)).note).toBeNull();
      expect(await listSnapshots(a.id, acc.id)).toHaveLength(1);
      expect(await listTrades(a.id, acc.id)).toHaveLength(1);
    });

    it("A's ids used through B's own account are 404 too", async () => {
      const { a, b, tx, imported, snap, bAcc, sec, trade } = await setup();
      const attempts: [keyof typeof actions, Record<string, string>][] = [
        [
          "updateTransaction",
          { transactionId: tx.id, bookingDate: "2024-01-01", amount: "1" },
        ],
        ["updateTransaction", { transactionId: imported.id, note: "x" }],
        ["deleteTransaction", { transactionId: tx.id }],
        ["setTaxYear", { transactionId: tx.id, taxYear: "2025" }],
        ["setDeductionYear", { transactionId: tx.id, deductionYear: "2025" }],
        ["deleteSnapshot", { snapshotId: snap.id }],
        ["addTrade", tradeForm(sec.id)],
        ["updateTrade", { tradeId: trade.id, ...tradeForm(sec.id) }],
        ["deleteTrade", { tradeId: trade.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, b, bAcc.id, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect((await getTransaction(a.id, tx.id)).description).toBe(
        "secret description",
      );
      expect(await listSnapshots(a.id, snap.accountId)).toHaveLength(1);
      expect(await listTrades(a.id, trade.accountId)).toHaveLength(1);
    });

    it("a trade of another account of the same user is 404", async () => {
      const { a, acc, trade } = await setup();
      const other = await seedAccount(a.id, { name: "Other" });
      for (const [name, form] of [
        ["updateTrade", { tradeId: trade.id, ...tradeForm(trade.securityId) }],
        ["deleteTrade", { tradeId: trade.id }],
      ] as const) {
        expect(await run(name, a, other.id, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(await listTrades(a.id, acc.id)).toHaveLength(1);
    });
  });
  it("marks a transaction as a tax payment and clears it again", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const tx = await manualTx(u.id, acc.id);
    expect(
      await run("setTaxYear", u, acc.id, {
        transactionId: tx.id,
        taxYear: "2025",
      }),
    ).toMatchObject({ type: "return" });
    expect((await getTransaction(u.id, tx.id)).taxYear).toBe(2025);
    expect(
      await run("setTaxYear", u, acc.id, {
        transactionId: tx.id,
        taxYear: "x",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    await run("setTaxYear", u, acc.id, { transactionId: tx.id, taxYear: "" });
    expect((await getTransaction(u.id, tx.id)).taxYear).toBeNull();
  });

  it("sets and clears the deduction year without touching the tax payment tag", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const tx = await manualTx(u.id, acc.id);
    await run("setTaxYear", u, acc.id, {
      transactionId: tx.id,
      taxYear: "2025",
    });
    expect(
      await run("setDeductionYear", u, acc.id, {
        transactionId: tx.id,
        deductionYear: "2024",
      }),
    ).toMatchObject({ type: "return" });
    expect(await getTransaction(u.id, tx.id)).toMatchObject({
      taxYear: 2025,
      deductionYear: 2024,
    });
    expect(
      await run("setDeductionYear", u, acc.id, {
        transactionId: tx.id,
        deductionYear: "x",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    await run("setDeductionYear", u, acc.id, {
      transactionId: tx.id,
      deductionYear: "",
    });
    expect(await getTransaction(u.id, tx.id)).toMatchObject({
      taxYear: 2025,
      deductionYear: null,
    });
  });

  describe("portfolios", () => {
    const pf = (over: Record<string, string> = {}) => ({
      name: "Portfolio 1",
      strategy: "Example strategy",
      depositReference: makeQrr(11),
      ...over,
    });

    it("loads portfolios, values and the portfolio breakdown", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      const p = await seedPortfolio(u.id, acc.id, { name: "P1" });
      await setValues(u.id, acc.id, "2025-01-01", [
        { portfolioId: p.id, amount: minor(123_400) },
      ]);
      const data = ((await loadAs(u, acc.id)) as { value: LoadData }).value;
      expect(data.showPortfolios).toBe(true);
      expect(data.hasHoldings).toBe(false);
      expect(data.portfolios.map((x: { id: string }) => x.id)).toEqual([p.id]);
      expect(data.portfolioValues[p.id]).toHaveLength(1);
      expect(data.value).toMatchObject({ portfolios: 123_400, total: 123_400 });
      expect(data.balance).toBe(123_400);
    });

    it("does not show portfolios on a plain account", async () => {
      const u = await createTestUser();
      const acc = await seedAccount(u.id);
      const data = ((await loadAs(u, acc.id)) as { value: LoadData }).value;
      expect(data.showPortfolios).toBe(false);
      expect(data.value).toBeNull();
    });

    it("adds, edits, closes, reopens and deletes a portfolio", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      expect(await run("addPortfolio", u, acc.id, pf())).toMatchObject({
        type: "return",
        value: { success: true, action: "addPortfolio" },
      });
      const [p] = await listPortfolios(u.id, acc.id);
      expect(p).toMatchObject({ name: "Portfolio 1", closedOn: null });

      expect(
        await run("updatePortfolio", u, acc.id, {
          portfolioId: p!.id,
          ...pf({ name: "Renamed" }),
        }),
      ).toMatchObject({ type: "return", value: { success: true } });
      expect((await getPortfolio(u.id, p!.id)).name).toBe("Renamed");

      expect(
        await run("closePortfolio", u, acc.id, {
          portfolioId: p!.id,
          closedOn: "2030-01-31",
          closeReason: "age",
        }),
      ).toMatchObject({ type: "return", value: { success: true } });
      expect(await getPortfolio(u.id, p!.id)).toMatchObject({
        closedOn: "2030-01-31",
        closeReason: "age",
      });

      expect(
        await run("reopenPortfolio", u, acc.id, { portfolioId: p!.id }),
      ).toMatchObject({ type: "return", value: { success: true } });
      expect((await getPortfolio(u.id, p!.id)).closedOn).toBeNull();

      expect(
        await run("deletePortfolio", u, acc.id, { portfolioId: p!.id }),
      ).toMatchObject({ type: "return", value: { success: true } });
      expect(await listPortfolios(u.id, acc.id)).toEqual([]);
    });

    it("validates portfolio input and echoes the values", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      const r = await run(
        "addPortfolio",
        u,
        acc.id,
        pf({ name: "", depositReference: "123" }),
      );
      expect(r).toMatchObject({
        type: "fail",
        status: 400,
        data: {
          action: "addPortfolio",
          errors: {
            name: expect.any(Array),
            depositReference: expect.any(Array),
          },
          values: { depositReference: "123" },
        },
      });
      const close = await run("closePortfolio", u, acc.id, {
        portfolioId: (await seedPortfolio(u.id, acc.id)).id,
        closedOn: "nope",
        closeReason: "age",
      });
      expect(close).toMatchObject({ type: "fail", status: 400 });
    });

    it("refuses portfolios on a non-3a account with a field error", async () => {
      const u = await createTestUser();
      const acc = await seedAccount(u.id);
      expect(await run("addPortfolio", u, acc.id, pf())).toMatchObject({
        type: "fail",
        status: 400,
      });
    });

    it("sets values for several portfolios at once and deletes one", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      const p1 = await seedPortfolio(u.id, acc.id, { name: "P1" });
      const p2 = await seedPortfolio(u.id, acc.id, { name: "P2" });
      expect(
        await run("setPortfolioValues", u, acc.id, {
          date: "2025-06-30",
          [`value:${p1.id}`]: "1000.50",
          [`value:${p2.id}`]: "",
        }),
      ).toMatchObject({ type: "return", value: { success: true } });
      const values = await listValues(u.id, p1.id);
      expect(values).toMatchObject([{ date: "2025-06-30", amount: 100_050 }]);
      expect(await listValues(u.id, p2.id)).toEqual([]);

      expect(
        await run("setPortfolioValues", u, acc.id, {
          date: "2025-06-30",
          [`value:${p1.id}`]: "abc",
        }),
      ).toMatchObject({ type: "fail", status: 400 });
      expect(
        await run("setPortfolioValues", u, acc.id, { date: "2025-06-30" }),
      ).toMatchObject({ type: "fail", status: 400 });

      expect(
        await run("deletePortfolioValue", u, acc.id, {
          portfolioId: p1.id,
          valueId: values[0]!.id,
        }),
      ).toMatchObject({ type: "return", value: { success: true } });
      expect(await listValues(u.id, p1.id)).toEqual([]);
    });

    it("refuses a portfolio of another account of the same user", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      const other = await seedPillar3aAccount(u.id, { name: "Other 3a" });
      const p = await seedPortfolio(u.id, other.id, { name: "Elsewhere" });
      await setValues(u.id, other.id, "2025-01-01", [
        { portfolioId: p.id, amount: minor(500) },
      ]);
      const [v] = await listValues(u.id, p.id);
      const attempts: [keyof typeof actions, Record<string, string>][] = [
        ["updatePortfolio", { portfolioId: p.id, ...pf() }],
        [
          "closePortfolio",
          { portfolioId: p.id, closedOn: "2030-01-01", closeReason: "age" },
        ],
        ["reopenPortfolio", { portfolioId: p.id }],
        ["deletePortfolio", { portfolioId: p.id }],
        ["setPortfolioValues", { date: "2025-02-01", [`value:${p.id}`]: "1" }],
        ["deletePortfolioValue", { portfolioId: p.id, valueId: v!.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, u, acc.id, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(await getPortfolio(u.id, p.id)).toMatchObject({
        name: "Elsewhere",
        closedOn: null,
      });
      expect(await listValues(u.id, p.id)).toHaveLength(1);
    });

    it("refuses a value id of another portfolio of the same account", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      const p1 = await seedPortfolio(u.id, acc.id, { name: "P1" });
      const p2 = await seedPortfolio(u.id, acc.id, { name: "P2" });
      await setValues(u.id, acc.id, "2025-01-01", [
        { portfolioId: p1.id, amount: minor(500) },
      ]);
      const [v] = await listValues(u.id, p1.id);
      expect(
        await run("deletePortfolioValue", u, acc.id, {
          portfolioId: p2.id,
          valueId: v!.id,
        }),
      ).toEqual({ type: "error", status: 404 });
      expect(await listValues(u.id, p1.id)).toHaveLength(1);
    });

    it("refuses another user's account, portfolios and values", async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      const acc = await seedPillar3aAccount(a.id);
      const p = await seedPortfolio(a.id, acc.id, { name: "A's portfolio" });
      await setValues(a.id, acc.id, "2025-01-01", [
        { portfolioId: p.id, amount: minor(500) },
      ]);
      const [v] = await listValues(a.id, p.id);
      const bAcc = await seedPillar3aAccount(b.id);

      const attempts: [keyof typeof actions, Record<string, string>][] = [
        ["addPortfolio", pf()],
        ["updatePortfolio", { portfolioId: p.id, ...pf() }],
        [
          "closePortfolio",
          { portfolioId: p.id, closedOn: "2030-01-01", closeReason: "age" },
        ],
        ["reopenPortfolio", { portfolioId: p.id }],
        ["deletePortfolio", { portfolioId: p.id }],
        ["setPortfolioValues", { date: "2025-02-01", [`value:${p.id}`]: "1" }],
        ["deletePortfolioValue", { portfolioId: p.id, valueId: v!.id }],
      ];
      for (const [name, form] of attempts) {
        expect(
          await run(name, b, acc.id, form),
          `${name} on A's account`,
        ).toEqual({
          type: "error",
          status: 404,
        });
      }
      // A's ids through B's own account are 404 as well.
      for (const [name, form] of attempts.slice(1)) {
        expect(
          await run(name, b, bAcc.id, form),
          `${name} via B's account`,
        ).toEqual({
          type: "error",
          status: 404,
        });
      }
      expect(await getPortfolio(a.id, p.id)).toMatchObject({
        name: "A's portfolio",
        closedOn: null,
      });
      expect(await listPortfolios(a.id, acc.id)).toHaveLength(1);
      expect(await listValues(a.id, p.id)).toHaveLength(1);
      expect(await listPortfolios(b.id, bAcc.id)).toEqual([]);
    });
  });
});

describe("account page: transfer linking", () => {
  useTestDB();

  async function setup(fill = true) {
    const u = await createTestUser();
    const a = await seedAccount(u.id, { name: "Main", iban: EXAMPLE_IBAN });
    const b = await seedAccount(u.id, {
      name: "Savings",
      type: "savings",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: fill,
    });
    const out = await seedImportedTransaction(u.id, a.id, {
      bookingDate: "2024-03-10",
      amount: minor(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    return { u, a, b, out };
  }
  const rowsOf = async (accountId: string) =>
    await getDB()
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.accountId, accountId));
  const accountForm = (over: Record<string, string> = {}) => ({
    name: "Savings",
    type: "savings",
    currency: "CHF",
    iban: EXAMPLE_IBAN_OTHER,
    // The form always posts this marker: a missing toggle then means off.
    fillFromTransfersField: "1",
    ...over,
  });

  it("toggles fill from transfers through the account form, backfilling and clearing", async () => {
    const { u, b } = await setup(false);
    expect(
      await run(
        "updateAccount",
        u,
        b.id,
        accountForm({ fillFromTransfers: "on" }),
      ),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect((await getAccount(u.id, b.id)).fillFromTransfers).toBe(true);
    expect(await rowsOf(b.id)).toHaveLength(1);

    // Deleting the mirrors has to be confirmed.
    expect(await run("updateAccount", u, b.id, accountForm())).toMatchObject({
      type: "fail",
      data: { errors: { fillFromTransfers: [expect.any(String)] } },
    });
    expect((await getAccount(u.id, b.id)).fillFromTransfers).toBe(true);
    expect(await rowsOf(b.id)).toHaveLength(1);

    await run(
      "updateAccount",
      u,
      b.id,
      accountForm({ confirmRemoveMirrors: "1" }),
    );
    expect((await getAccount(u.id, b.id)).fillFromTransfers).toBe(false);
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("stores trades move cash for investment accounts only", async () => {
    const u = await createTestUser();
    const inv = await seedAccount(u.id, { type: "investment" });
    const cur = await seedAccount(u.id, { name: "Cur" });
    await run("updateAccount", u, inv.id, {
      name: "Broker",
      type: "investment",
      currency: "CHF",
      tradesMoveCash: "on",
    });
    await run("updateAccount", u, cur.id, {
      name: "Cur",
      type: "current",
      currency: "CHF",
      tradesMoveCash: "on",
    });
    expect((await getAccount(u.id, inv.id)).tradesMoveCash).toBe(true);
    expect((await getAccount(u.id, cur.id)).tradesMoveCash).toBe(false);
  });

  it("enables the toggle with a backfill and reports what it linked", async () => {
    const { u, b } = await setup(false);
    const before = ((await loadAs(u, b.id)) as { value: LoadData }).value;
    expect(before.transfers).toEqual({
      mirrorCount: 0,
      fillSuggestion: { count: 1 },
      needsAmount: [],
    });
    expect(await run("enableFillFromTransfers", u, b.id)).toMatchObject({
      type: "return",
      value: {
        success: true,
        action: "enableFillFromTransfers",
        paired: 0,
        mirrored: 1,
        needsAmount: 0,
      },
    });
    const after = ((await loadAs(u, b.id)) as { value: LoadData }).value;
    expect(after.account.fillFromTransfers).toBe(true);
    expect(after.transfers).toMatchObject({
      mirrorCount: 1,
      fillSuggestion: null,
    });
    const mirror = after.transactions.items[0]!;
    expect(mirror).toMatchObject({
      source: "mirror",
      amount: 10000,
      mirrorOf: { accountName: "Main" },
      transfer: { status: "linked", peerAccountName: "Main" },
    });
  });

  it("refuses to enable filling on a pillar 3a account", async () => {
    const u = await createTestUser();
    const p3a = await seedPillar3aAccount(u.id, { iban: EXAMPLE_IBAN });
    expect(await run("enableFillFromTransfers", u, p3a.id)).toMatchObject({
      type: "fail",
      status: 400,
    });
  });

  it("unlinks a transfer from either account's row and remembers it", async () => {
    const { u, a, b, out } = await setup();
    await linkTransfers(u.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    expect(
      await run("unlinkTransfer", u, b.id, { transactionId: mirror.id }),
    ).toMatchObject({
      type: "return",
      value: { success: true, action: "unlinkTransfer" },
    });
    expect(await rowsOf(b.id)).toEqual([]);
    await linkTransfers(u.id, {});
    expect(await rowsOf(b.id)).toEqual([]);
    // nothing left to unlink
    expect(
      await run("unlinkTransfer", u, a.id, { transactionId: out.id }),
    ).toEqual({
      type: "error",
      status: 404,
    });
    expect(await run("unlinkTransfer", u, a.id, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
  });

  it("links two rows by hand, with candidates for the picker", async () => {
    const { u, a, b } = await setup(false);
    const out = await seedImportedTransaction(u.id, a.id, {
      bookingDate: "2024-04-02",
      amount: minor(-7000),
    });
    const into = await seedImportedTransaction(u.id, b.id, {
      bookingDate: "2024-04-03",
      amount: minor(7000),
    });
    const found = await run("transferCandidates", u, a.id, {
      transactionId: out.id,
    });
    expect(found).toMatchObject({
      type: "return",
      value: {
        success: true,
        action: "transferCandidates",
        transactionId: out.id,
        candidates: [
          {
            id: into.id,
            accountId: b.id,
            accountName: "Savings",
            exact: true,
            days: 1,
          },
        ],
      },
    });

    expect(
      await run("linkTransfer", u, a.id, {
        transactionId: out.id,
        peerId: into.id,
      }),
    ).toMatchObject({
      type: "return",
      value: { success: true, action: "linkTransfer" },
    });
    const view = (
      (await loadAs(u, a.id)) as { value: LoadData }
    ).value.transactions.items.find((t: { id: string }) => t.id === out.id)!;
    expect(view.transfer).toMatchObject({
      method: "manual",
      direction: "out",
      peerTransactionId: into.id,
    });
    // from the credit side, and a second link is refused
    expect(
      await run("linkTransfer", u, b.id, {
        transactionId: into.id,
        peerId: out.id,
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(
      await run("linkTransfer", u, b.id, { transactionId: into.id }),
    ).toMatchObject({ type: "fail", status: 400 });
  });

  it("resolves a transfer that needs an amount, on the receiving account's page only", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id, { name: "Main", iban: EXAMPLE_IBAN });
    const eur = await seedAccount(u.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    await seedImportedTransaction(u.id, a.id, {
      bookingDate: "2024-03-10",
      amount: minor(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(u.id, {});
    const [pending] = await listNeedsAmount(u.id);
    const data = ((await loadAs(u, eur.id)) as { value: LoadData }).value;
    expect(data.transfers.needsAmount).toHaveLength(1);
    expect(
      ((await loadAs(u, a.id)) as { value: LoadData }).value.transfers
        .needsAmount,
    ).toEqual([]);

    expect(
      await run("resolveNeedsAmount", u, a.id, {
        transferId: pending!.transferId,
        amount: "93.00",
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await run("resolveNeedsAmount", u, eur.id, {
        transferId: pending!.transferId,
        amount: "abc",
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { amount: [expect.any(String)] } },
    });
    expect(
      await run("resolveNeedsAmount", u, eur.id, {
        transferId: pending!.transferId,
        amount: "0",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(
      await run("resolveNeedsAmount", u, eur.id, {
        transferId: pending!.transferId,
        amount: "93.00",
      }),
    ).toMatchObject({
      type: "return",
      value: { success: true, action: "resolveNeedsAmount" },
    });
    expect((await rowsOf(eur.id))[0]).toMatchObject({
      amount: 9300,
      currency: "EUR",
    });
    expect(await listNeedsAmount(u.id)).toEqual([]);
  });

  it("offers the row to link instead of an amount, and links it from the receiving account's page", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id, { name: "Main", iban: EXAMPLE_IBAN });
    const eur = await seedAccount(u.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const out = await seedImportedTransaction(u.id, a.id, {
      bookingDate: "2024-03-10",
      amount: minor(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(u.id, {});
    const real = await seedImportedTransaction(u.id, eur.id, {
      bookingDate: "2024-03-11",
      amount: minor(9300),
      currency: "EUR",
    });
    const [pending] = await listNeedsAmount(u.id);
    const data = ((await loadAs(u, eur.id)) as { value: LoadData }).value;
    expect(data.transfers.needsAmount[0]!.linkCandidate).toMatchObject({
      id: real.id,
    });
    expect(
      await run("resolveNeedsAmount", u, eur.id, {
        transferId: pending!.transferId,
        amount: "93.00",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(
      await run("linkNeedsAmount", u, a.id, {
        transferId: pending!.transferId,
        peerId: real.id,
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await run("linkNeedsAmount", u, eur.id, {
        transferId: pending!.transferId,
        peerId: out.id,
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(
      await run("linkNeedsAmount", u, eur.id, {
        transferId: pending!.transferId,
        peerId: real.id,
      }),
    ).toMatchObject({
      type: "return",
      value: { success: true, action: "linkNeedsAmount" },
    });
    expect(await listNeedsAmount(u.id)).toEqual([]);
    expect(await rowsOf(eur.id)).toHaveLength(1);
  });

  it("keeps mirrors in step with a manual source row", async () => {
    const { u, a, b } = await setup();
    const added = await run("addTransaction", u, a.id, {
      bookingDate: "2024-05-01",
      amount: "-20.00",
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      description: "Top up",
    });
    const id = (added as { value: { id: string } }).value.id;
    const mirror = (await rowsOf(b.id)).find((r) => r.mirrorOfId === id)!;
    expect(mirror).toMatchObject({ amount: 2000, description: "Top up" });

    await run("updateTransaction", u, a.id, {
      transactionId: id,
      bookingDate: "2024-05-02",
      amount: "-25.50",
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      description: "Top up more",
    });
    expect((await rowsOf(b.id)).find((r) => r.id === mirror.id)).toMatchObject({
      amount: 2550,
      bookingDate: "2024-05-02",
      description: "Top up more",
    });

    // dropping the counterparty removes the mirror
    await run("updateTransaction", u, a.id, {
      transactionId: id,
      bookingDate: "2024-05-02",
      amount: "-25.50",
      description: "Top up more",
    });
    expect((await rowsOf(b.id)).some((r) => r.mirrorOfId === id)).toBe(false);

    await run("deleteTransaction", u, a.id, { transactionId: id });
    expect((await rowsOf(a.id)).some((r) => r.id === id)).toBe(false);
  });

  it("only lets mirrors change their note", async () => {
    const { u, b } = await setup();
    await linkTransfers(u.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    expect(
      await run("updateTransaction", u, b.id, {
        transactionId: mirror.id,
        note: "checked",
        amount: "1",
        bookingDate: "2024-03-11",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect((await rowsOf(b.id))[0]).toMatchObject({
      note: "checked",
      amount: 10000,
      bookingDate: "2024-03-10",
    });
  });

  it("answers 404 for every transfer action on another user's rows or accounts", async () => {
    const { u, a, b, out } = await setup();
    await linkTransfers(u.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    const intruder = await createTestUser();
    const own = await seedAccount(intruder.id, { name: "Own" });
    const mine = await seedImportedTransaction(intruder.id, own.id, {
      amount: minor(10000),
    });
    const notFound = { type: "error", status: 404 };

    // foreign account page
    for (const name of [
      "unlinkTransfer",
      "linkTransfer",
      "transferCandidates",
    ] as const) {
      expect(
        await run(name, intruder, a.id, {
          transactionId: out.id,
          peerId: mine.id,
        }),
      ).toEqual(notFound);
    }
    expect(await run("enableFillFromTransfers", intruder, b.id)).toEqual(
      notFound,
    );
    expect(
      await run("resolveNeedsAmount", intruder, b.id, {
        transferId: "x",
        amount: "1",
      }),
    ).toEqual(notFound);
    expect(
      await run("linkNeedsAmount", intruder, b.id, {
        transferId: "x",
        peerId: mine.id,
      }),
    ).toEqual(notFound);

    // own account page, foreign ids
    expect(
      await run("unlinkTransfer", intruder, own.id, {
        transactionId: mirror.id,
      }),
    ).toEqual(notFound);
    expect(
      await run("transferCandidates", intruder, own.id, {
        transactionId: out.id,
      }),
    ).toEqual(notFound);
    expect(
      await run("linkTransfer", intruder, own.id, {
        transactionId: mine.id,
        peerId: out.id,
      }),
    ).toEqual(notFound);
    expect(
      await run("linkTransfer", intruder, own.id, {
        transactionId: mine.id,
        peerId: mirror.id,
      }),
    ).toEqual(notFound);
    expect(await loadAs(intruder, b.id)).toEqual(notFound);

    expect(await rowsOf(b.id)).toHaveLength(1);
    expect(await listNeedsAmount(intruder.id)).toEqual([]);
  });
});

describe("account detail page: external links and ?tx=", () => {
  useTestDB();

  const link = {
    source: "home app",
    label: "Costs 2026",
    url: "https://home.example.org/costs",
  };

  it("hands the links of the listed transactions to the page", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const tx = await manualTx(u.id, acc.id);
    const other = await manualTx(u.id, acc.id, "other");
    await createLink(u.id, "transaction", tx.id, link);
    const r = await loadAs(u, acc.id);
    const v = (r as { value: LoadData }).value;
    expect(v.transactionLinks[tx.id]).toEqual([
      { id: expect.any(String), ...link },
    ]);
    expect(v.transactionLinks[other.id]).toBeUndefined();
    expect(v.focused).toBeNull();
  });

  it("does not show another user's links on the user's transactions", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const tx = await manualTx(a.id, acc.id);
    await createLink(b.id, "transaction", tx.id, link);
    const v = ((await loadAs(a, acc.id)) as { value: LoadData }).value;
    expect(v.transactionLinks).toEqual({});
  });

  it("?tx= focuses a transaction of this account, wherever it sits in the list", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const old = await seedImportedTransaction(u.id, acc.id, {
      bookingDate: "2020-01-01",
    });
    for (let i = 0; i < 3; i++) await manualTx(u.id, acc.id, `row ${i}`);
    await createLink(u.id, "transaction", old.id, link);
    const v = (
      (await loadAs(u, acc.id, `?tx=${old.id}&pageSize=1`)) as {
        value: LoadData;
      }
    ).value;
    expect(v.transactions.items.map((t: { id: string }) => t.id)).not.toContain(
      old.id,
    );
    expect(v.focused?.id).toBe(old.id);
    expect(v.transactionLinks[old.id]).toHaveLength(1);
  });

  it("?tx= ignores transactions of another account or user, and nonsense", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const acc = await seedAccount(a.id);
    const second = await seedAccount(a.id, { name: "Second" });
    const theirs = await seedAccount(b.id);
    const mine = await manualTx(a.id, second.id);
    const foreign = await manualTx(b.id, theirs.id);
    for (const id of [mine.id, foreign.id, "nope", ""]) {
      const v = ((await loadAs(a, acc.id, `?tx=${id}`)) as { value: LoadData })
        .value;
      expect(v.focused, id).toBeNull();
    }
  });
});
