import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { accounts, getDB, transactions, transfers } from "$lib/server/db";
import { allocate } from "$lib/server/bills/allocations";
import { candidateTransactions } from "$lib/server/bills/candidates";
import { getSuggestions } from "$lib/server/bills/suggestions";
import {
  applyRulesToUncategorized,
  createRule,
} from "$lib/server/categories/rules";
import { createCategory } from "$lib/server/categories/categories";
import { spendingByCategory } from "$lib/server/categories/budgets";
import { monthSummary, unmatchedTransactions } from "$lib/server/dashboard";
import {
  deleteAccount,
  getAccount,
  setAccountArchived,
  updateAccount,
} from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { accountInputSchema } from "$lib/server/ledger/schemas";
import {
  createManualTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "$lib/server/ledger/transactions";
import { undoImport } from "$lib/server/imports/history";
import { syncRecurring, listRecurring } from "$lib/server/recurring/series";
import { yearReview } from "$lib/server/review";
import { detectedContributions } from "$lib/server/pillar3a";
import {
  addTaxCredit,
  reconcileYear,
  setTransactionTaxYear,
  upsertTaxYear,
} from "$lib/server/tax/tax";
import {
  deductionSummary,
  setCategoryDeduction,
  setTransactionDeductionExcluded,
  setTransactionDeductionYear,
} from "$lib/server/tax/deductions";
import {
  taxCreditInputSchema,
  taxYearInputSchema,
} from "$lib/server/tax/schemas";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
  EXAMPLE_SCOR,
  FOREIGN_IBANS,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  seedAccount,
  seedImport,
  seedImportedTransaction,
} from "$lib/testing/ledger";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import {
  countMirrors,
  enableFill,
  findReplacements,
  linkAfterWrite,
  fillSuggestion,
  linkManually,
  linkNeedsAmountTo,
  linkTransfers,
  listNeedsAmount,
  ownIbans,
  removeMirrors,
  resolveNeedsAmount,
  revalidateLinks,
  transferCandidates,
  unlink,
} from "./index";

useTestDB();

const m = minor;

async function setup(over: { fill?: boolean } = {}) {
  const user = await createTestUser();
  const a = seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
  const b = seedAccount(user.id, {
    name: "Savings",
    type: "savings",
    iban: EXAMPLE_IBAN_OTHER,
    fillFromTransfers: over.fill ?? true,
  });
  const send = (over: Parameters<typeof seedImportedTransaction>[2] = {}) =>
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      description: "Move to savings",
      ...over,
    });
  return { user, a, b, send };
}

const inputOf = (view: ReturnType<typeof getAccount>) => ({
  institutionId: null,
  name: view.name,
  type: view.type,
  currency: view.currency,
  iban: view.iban,
  contractNumber: null,
  depositIban: null,
  openingBalance: view.openingBalance,
  openingDate: view.openingDate,
  noticeMonths: null,
  freeWithdrawal: null,
  freeWithdrawalPeriod: null,
  shareBps: view.shareBps,
  sharedWith: null,
  sortOrder: null,
  fillFromTransfers: view.fillFromTransfers,
  tradesMoveCash: view.tradesMoveCash,
});

const rowsOf = (accountId: string) =>
  getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all();
const allTransfers = () => getDB().select().from(transfers).all();

describe("linkTransfers", () => {
  it("mirrors a transfer onto an account filled from transfers", async () => {
    const { user, a, b, send } = await setup();
    const out = send({
      valueDate: "2026-03-11",
      reference: EXAMPLE_SCOR,
    });

    expect(linkTransfers(user.id, { transactionIds: [out.id] })).toEqual({
      paired: 0,
      mirrored: 1,
      needsAmount: 0,
    });
    const [mirror] = rowsOf(b.id);
    expect(mirror).toMatchObject({
      userId: user.id,
      source: "mirror",
      importId: null,
      externalId: `mirror:${out.id}`,
      mirrorOfId: out.id,
      bookingDate: "2026-03-10",
      valueDate: "2026-03-11",
      amount: 10000,
      currency: "CHF",
      counterpartyName: "Main",
      counterpartyIban: EXAMPLE_IBAN,
      description: "Move to savings",
      reference: EXAMPLE_SCOR,
      categoryId: null,
    });
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        outTransactionId: out.id,
        inTransactionId: mirror!.id,
        status: "linked",
        method: "mirrored",
        fromAccountId: a.id,
        toAccountId: b.id,
      }),
    ]);
    expect(getAccount(user.id, b.id, "2026-12-31").balance).toBe(10000);
  });

  it("mirrors an incoming payment as a debit and is idempotent", async () => {
    const { user, a, b, send } = await setup();
    const into = send({ amount: m(2500) });
    linkTransfers(user.id, {});
    expect(linkTransfers(user.id, {})).toEqual({
      paired: 0,
      mirrored: 0,
      needsAmount: 0,
    });
    expect(rowsOf(b.id)).toHaveLength(1);
    expect(rowsOf(b.id)[0]!.amount).toBe(-2500);
    expect(allTransfers()[0]).toMatchObject({
      inTransactionId: into.id,
      fromAccountId: b.id,
      toAccountId: a.id,
    });
  });

  it("pairs two real rows and creates no mirror", async () => {
    const { user, a, b, send } = await setup();
    const out = send();
    const into = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-12",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN,
    });
    expect(linkTransfers(user.id, {})).toMatchObject({
      paired: 1,
      mirrored: 0,
    });
    expect(rowsOf(b.id)).toHaveLength(1);
    expect(allTransfers()[0]).toMatchObject({
      outTransactionId: out.id,
      inTransactionId: into.id,
      status: "linked",
      method: "paired",
      fromAccountId: a.id,
      toAccountId: b.id,
    });
  });

  it("scopes sources by transaction, source account or target account", async () => {
    const { user, b, send } = await setup();
    const one = send();
    const two = send({ bookingDate: "2026-04-10" });
    expect(linkTransfers(user.id, { transactionIds: [one.id] }).mirrored).toBe(
      1,
    );
    expect(linkTransfers(user.id, { sourceAccountId: b.id }).mirrored).toBe(0);
    expect(
      linkTransfers(user.id, { targetAccountId: b.id, to: "2026-03-31" })
        .mirrored,
    ).toBe(0);
    expect(linkTransfers(user.id, { targetAccountId: b.id }).mirrored).toBe(1);
    expect(
      rowsOf(b.id)
        .map((r) => r.mirrorOfId)
        .sort(),
    ).toEqual([one.id, two.id].sort());
  });

  it("creates no mirror when the toggle is off, and enabling backfills", async () => {
    const { user, b, send } = await setup({ fill: false });
    send();
    send({ bookingDate: "2026-04-10", amount: m(-500) });
    expect(linkTransfers(user.id, {}).mirrored).toBe(0);
    expect(fillSuggestion(user.id, b.id)).toEqual({ count: 2 });

    expect(enableFill(user.id, b.id)).toMatchObject({ mirrored: 2 });
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(true);
    expect(rowsOf(b.id)).toHaveLength(2);
    expect(fillSuggestion(user.id, b.id)).toBeNull();
  });

  it("refuses to enable filling on an archived account and offers no suggestion for it", async () => {
    const { user, b, send } = await setup({ fill: false });
    send();
    setAccountArchived(user.id, b.id, true);
    expect(fillSuggestion(user.id, b.id)).toBeNull();
    expect(() => enableFill(user.id, b.id)).toThrow(/archived/i);
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(false);
    expect(rowsOf(b.id)).toEqual([]);
  });

  it("needs the removal confirmed when the toggle goes off on an account with mirrors", async () => {
    const { user, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    const off = {
      ...inputOf(getAccount(user.id, b.id)),
      fillFromTransfers: false,
    };
    expect(() => updateAccount(user.id, b.id, off)).toThrow(
      expect.objectContaining({ code: "invalid", field: "fillFromTransfers" }),
    );
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(true);
    expect(rowsOf(b.id)).toHaveLength(1);
    updateAccount(user.id, b.id, { ...off, confirmRemoveMirrors: true });
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(false);
    expect(rowsOf(b.id)).toEqual([]);
  });

  it("turns the toggle off without confirmation when there are no mirrors", async () => {
    const { user, b } = await setup();
    updateAccount(user.id, b.id, {
      ...inputOf(getAccount(user.id, b.id)),
      fillFromTransfers: false,
    });
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(false);
  });

  it("reads confirmRemoveMirrors from the form", () => {
    const base = {
      name: "X",
      type: "savings",
      currency: "CHF",
      fillFromTransfersField: "1",
    };
    expect(accountInputSchema.parse(base).confirmRemoveMirrors).toBe(false);
    expect(
      accountInputSchema.parse({ ...base, confirmRemoveMirrors: "1" })
        .confirmRemoveMirrors,
    ).toBe(true);
  });

  it("backfills when the toggle is switched on through updateAccount", async () => {
    const { user, b, send } = await setup({ fill: false });
    send();
    const view = getAccount(user.id, b.id);
    updateAccount(user.id, b.id, { ...inputOf(view), fillFromTransfers: true });
    expect(countMirrors(user.id, b.id)).toBe(1);

    updateAccount(user.id, b.id, {
      ...inputOf(getAccount(user.id, b.id)),
      fillFromTransfers: false,
      confirmRemoveMirrors: true,
    });
    expect(countMirrors(user.id, b.id)).toBe(0);
    expect(allTransfers()).toEqual([]);
  });

  it("removes mirrors and pending amounts when filling is turned off", async () => {
    const { user, b, send } = await setup();
    const eur = seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_THIRD,
      fillFromTransfers: true,
    });
    send();
    send({ counterpartyIban: EXAMPLE_IBAN_THIRD, bookingDate: "2026-03-11" });
    linkTransfers(user.id, {});
    expect(listNeedsAmount(user.id, eur.id)).toHaveLength(1);

    getDB().transaction((tx) => removeMirrors(user.id, eur.id, tx));
    expect(listNeedsAmount(user.id)).toEqual([]);
    expect(countMirrors(user.id, b.id)).toBe(1);
  });

  it("never mirrors before the opening date or onto pillar 3a and portfolio accounts", async () => {
    const { user, send } = await setup({ fill: false });
    const dated = seedAccount(user.id, {
      name: "Dated",
      iban: EXAMPLE_IBAN_THIRD,
      openingDate: "2026-03-11",
      fillFromTransfers: true,
    });
    send({ counterpartyIban: EXAMPLE_IBAN_THIRD, bookingDate: "2026-03-10" });
    expect(linkTransfers(user.id, {}).mirrored).toBe(0);
    send({ counterpartyIban: EXAMPLE_IBAN_THIRD, bookingDate: "2026-03-11" });
    expect(linkTransfers(user.id, {}).mirrored).toBe(1);
    expect(countMirrors(user.id, dated.id)).toBe(1);

    const p3a = seedPillar3aAccount(user.id, {
      iban: FOREIGN_IBANS[0]!,
      fillFromTransfers: true,
    });
    expect(getAccount(user.id, p3a.id).fillFromTransfers).toBe(false);
    getDB()
      .update(accounts)
      .set({ fillFromTransfers: true })
      .where(eq(accounts.id, p3a.id))
      .run();
    seedPortfolio(user.id, p3a.id);
    send({ counterpartyIban: FOREIGN_IBANS[0]! });
    expect(linkTransfers(user.id, {}).mirrored).toBe(0);
    expect(() => enableFill(user.id, p3a.id)).toThrow(LedgerError);
  });

  it("forces the toggles off for pillar 3a in the form schema", () => {
    const parsed = accountInputSchema.parse({
      name: "Retirement",
      type: "pillar_3a",
      currency: "CHF",
      fillFromTransfers: "on",
      tradesMoveCash: "on",
    });
    expect(parsed).toMatchObject({
      fillFromTransfers: false,
      tradesMoveCash: false,
    });
    const current = accountInputSchema.parse({
      name: "Main",
      type: "current",
      currency: "CHF",
      fillFromTransfers: "on",
    });
    expect(current).toMatchObject({
      fillFromTransfers: true,
      tradesMoveCash: false,
    });
  });

  it("reads the fill toggle from the form only when its marker came along", () => {
    const base = { name: "Main", type: "current", currency: "CHF" };
    const fill = (extra: Record<string, string>) =>
      accountInputSchema.parse({ ...base, ...extra }).fillFromTransfers;
    expect(fill({})).toBeUndefined();
    expect(fill({ fillFromTransfersField: "1" })).toBe(false);
    expect(fill({ fillFromTransfersField: "1", fillFromTransfers: "on" })).toBe(
      true,
    );
    expect(fill({ fillFromTransfers: "on" })).toBe(true);
    expect(
      accountInputSchema.parse({ ...base, fillFromTransfersField: "1" }),
    ).not.toHaveProperty("fillFromTransfersField");
  });

  it("keeps the stored toggle and the mirrors when an update omits the field", async () => {
    const { user, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    const input = {
      ...inputOf(getAccount(user.id, b.id)),
      fillFromTransfers: undefined,
    };
    updateAccount(user.id, b.id, { ...input, name: "Renamed" });
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(true);
    expect(rowsOf(b.id)).toHaveLength(1);
    updateAccount(user.id, b.id, {
      ...input,
      fillFromTransfers: false,
      confirmRemoveMirrors: true,
    });
    expect(getAccount(user.id, b.id).fillFromTransfers).toBe(false);
    expect(rowsOf(b.id)).toEqual([]);
  });

  it("recognises archived accounts and ignores deposit IBANs", async () => {
    const { user, b, send } = await setup();
    send();
    setAccountArchived(user.id, b.id, true);
    expect(ownIbans(user.id).get(EXAMPLE_IBAN_OTHER)).toBe(b.id);
    // Still addressable, but nothing new is mirrored onto it.
    expect(linkTransfers(user.id, {}).mirrored).toBe(0);
    expect(rowsOf(b.id)).toEqual([]);
    setAccountArchived(user.id, b.id, false);
    expect(linkTransfers(user.id, {}).mirrored).toBe(1);

    const p3a = seedPillar3aAccount(user.id, {
      depositIban: EXAMPLE_IBAN_THIRD,
    });
    expect([...ownIbans(user.id).values()]).not.toContain(p3a.id);
    expect(ownIbans(user.id).has(EXAMPLE_IBAN_THIRD)).toBe(false);
  });

  it("removes the mirror and its transfer with the source row or its import", async () => {
    const { user, a, b, send } = await setup();
    const imp = seedImport(user.id, a.id);
    const fromImport = send({ importId: imp.id });
    const manual = send({
      source: "manual",
      externalId: "manual:1",
      bookingDate: "2026-03-20",
    });
    linkTransfers(user.id, {});
    expect(rowsOf(b.id)).toHaveLength(2);

    undoImport(user.id, imp.id);
    expect(rowsOf(a.id).map((r) => r.id)).toEqual([manual.id]);
    expect(rowsOf(b.id)).toHaveLength(1);
    expect(rowsOf(a.id).some((r) => r.id === fromImport.id)).toBe(false);

    deleteTransaction(user.id, manual.id);
    expect(rowsOf(b.id)).toEqual([]);
    expect(allTransfers()).toEqual([]);
  });

  it("removes mirrors and transfers when the source account is deleted", async () => {
    const { user, a, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    expect(rowsOf(b.id)).toHaveLength(1);
    deleteAccount(user.id, a.id);
    expect(rowsOf(b.id)).toEqual([]);
    expect(allTransfers()).toEqual([]);
  });

  it("keeps working when the same IBAN belongs to another user", async () => {
    const { user, b, send } = await setup();
    const other = await createTestUser();
    const theirs = seedAccount(other.id, {
      name: "Theirs",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    send();
    expect(linkTransfers(other.id, {})).toEqual({
      paired: 0,
      mirrored: 0,
      needsAmount: 0,
    });
    expect(rowsOf(theirs.id)).toEqual([]);
    expect(linkTransfers(user.id, {}).mirrored).toBe(1);
    expect(rowsOf(theirs.id)).toEqual([]);
    expect(rowsOf(b.id)).toHaveLength(1);
  });
});

describe("foreign currency transfers", () => {
  async function fx() {
    const user = await createTestUser();
    const a = seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
    const eur = seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    return { user, a, eur };
  }

  it("uses the statement's counter-amount", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      originalAmount: m(-9300),
      originalCurrency: "EUR",
    });
    linkTransfers(user.id, {});
    expect(rowsOf(eur.id)[0]).toMatchObject({
      amount: 9300,
      currency: "EUR",
      source: "mirror",
    });
  });

  it("lists the transfer as needing an amount, then creates the mirror", async () => {
    const { user, a, eur } = await fx();
    const out = seedImportedTransaction(user.id, a.id, {
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      description: "Move",
    });
    expect(linkTransfers(user.id, {})).toMatchObject({
      mirrored: 0,
      needsAmount: 1,
    });
    expect(rowsOf(eur.id)).toEqual([]);
    const [pending] = listNeedsAmount(user.id, eur.id);
    expect(pending).toMatchObject({
      sourceTransactionId: out.id,
      sourceAccountId: a.id,
      sourceAccountName: "Main",
      targetAccountId: eur.id,
      targetAccountName: "Euro",
      targetCurrency: "EUR",
      direction: "in",
      amount: -10000,
      currency: "CHF",
      description: "Move",
    });
    expect(listNeedsAmount(user.id, a.id)).toEqual([]);
    expect(getTransaction(user.id, out.id).transfer).toMatchObject({
      status: "needs_amount",
      peerAccountId: eur.id,
      peerTransactionId: null,
    });

    resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect(rowsOf(eur.id)[0]).toMatchObject({ amount: 9300, currency: "EUR" });
    expect(allTransfers()[0]).toMatchObject({
      status: "linked",
      method: "mirrored",
      outTransactionId: out.id,
    });
    expect(listNeedsAmount(user.id)).toEqual([]);
    expect(() =>
      resolveNeedsAmount(user.id, pending!.transferId, m(1)),
    ).toThrow(/needs no amount/);
  });

  it("books an incoming FX transfer as a debit and rejects bad amounts", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      amount: m(5000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const [pending] = listNeedsAmount(user.id);
    expect(pending).toMatchObject({
      direction: "out",
      targetAccountId: eur.id,
    });
    expect(() =>
      resolveNeedsAmount(user.id, pending!.transferId, m(0)),
    ).toThrow(LedgerError);
    expect(() =>
      resolveNeedsAmount(user.id, pending!.transferId, m(-3)),
    ).toThrow(LedgerError);
    resolveNeedsAmount(user.id, pending!.transferId, m(4600));
    expect(rowsOf(eur.id)[0]!.amount).toBe(-4600);
    expect(allTransfers()[0]).toMatchObject({
      inTransactionId: expect.any(String),
      outTransactionId: rowsOf(eur.id)[0]!.id,
    });
  });

  const euroCredit = (
    user: { id: string },
    eurId: string,
    over: Parameters<typeof seedImportedTransaction>[2] = {},
  ) =>
    seedImportedTransaction(user.id, eurId, {
      bookingDate: "2026-03-11",
      amount: m(9300),
      currency: "EUR",
      originalAmount: m(10000),
      originalCurrency: "CHF",
      counterpartyIban: EXAMPLE_IBAN,
      ...over,
    });

  it("pairs a waiting debit with the counterpart that arrives later instead of asking again", async () => {
    const { user, a, eur } = await fx();
    const out = seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    expect(linkTransfers(user.id, {}).needsAmount).toBe(1);
    const credit = euroCredit(user, eur.id);
    const result = getDB().transaction((tx) =>
      linkAfterWrite(user.id, eur.id, [credit.id], [credit.bookingDate], tx),
    );
    expect(result).toMatchObject({ paired: 1, needsAmount: 0, mirrored: 0 });
    expect(listNeedsAmount(user.id)).toEqual([]);
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        method: "paired",
        outTransactionId: out.id,
        inTransactionId: credit.id,
      }),
    ]);
    expect(rowsOf(eur.id)).toHaveLength(1);
  });

  it("pairs the same two rows within one run, the debit dated earlier", async () => {
    const { user, a, eur } = await fx();
    const out = seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-09",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    const credit = euroCredit(user, eur.id);
    expect(linkTransfers(user.id, {})).toMatchObject({
      paired: 1,
      needsAmount: 0,
      mirrored: 0,
    });
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        outTransactionId: out.id,
        inTransactionId: credit.id,
      }),
    ]);
    expect(rowsOf(eur.id)).toHaveLength(1);
  });

  it("refuses to resolve while the receiving account has an unlinked opposite row near the date", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const [pending] = listNeedsAmount(user.id);
    const near = seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
    });
    expect(() =>
      resolveNeedsAmount(user.id, pending!.transferId, m(9300)),
    ).toThrow(/link/i);
    expect(rowsOf(eur.id)).toHaveLength(1);
    // Once that row is part of another transfer it no longer blocks.
    const other = seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-30",
      amount: m(-9000),
    });
    linkManually(user.id, other.id, near.id);
    resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect(rowsOf(eur.id)).toHaveLength(2);
  });

  it("only lets a row that names no other account block resolving, and says which one", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const [pending] = listNeedsAmount(user.id);
    expect(pending!.linkCandidate).toBeNull();
    // Another payment: it names someone else.
    seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
      counterpartyIban: EXAMPLE_IBAN_THIRD,
    });
    expect(listNeedsAmount(user.id)[0]!.linkCandidate).toBeNull();
    resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect(rowsOf(eur.id)).toHaveLength(2);
  });

  it("names the row to link when resolving is refused, and links it instead", async () => {
    const { user, a, eur } = await fx();
    const out = seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const near = seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
      counterpartyIban: EXAMPLE_IBAN,
    });
    const [pending] = listNeedsAmount(user.id);
    expect(pending!.linkCandidate).toMatchObject({
      id: near.id,
      bookingDate: "2026-03-12",
    });
    expect(() =>
      resolveNeedsAmount(user.id, pending!.transferId, m(9300)),
    ).toThrow(
      expect.objectContaining({ code: "conflict", candidateId: near.id }),
    );
    linkNeedsAmountTo(user.id, pending!.transferId, near.id);
    expect(listNeedsAmount(user.id)).toEqual([]);
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        method: "manual",
        outTransactionId: out.id,
        inTransactionId: near.id,
      }),
    ]);
    expect(rowsOf(eur.id)).toHaveLength(1);
  });

  it("links a needs-amount transfer only to rows of the receiving account and only for its owner", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const [pending] = listNeedsAmount(user.id);
    const wrong = seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-12",
      amount: m(500),
    });
    expect(() =>
      linkNeedsAmountTo(user.id, pending!.transferId, wrong.id),
    ).toThrow(LedgerError);
    const right = seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
    });
    const other = await createTestUser();
    expect(() =>
      linkNeedsAmountTo(other.id, pending!.transferId, right.id),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(listNeedsAmount(user.id)).toHaveLength(1);
  });

  it("does not let a far-away or same-direction row block resolving", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-20",
      amount: m(9000),
      currency: "EUR",
    });
    seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-11",
      amount: m(-9000),
      currency: "EUR",
    });
    const [pending] = listNeedsAmount(user.id);
    resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect(allTransfers()[0]).toMatchObject({ status: "linked" });
  });

  it("refuses to resolve once filling was turned off", async () => {
    const { user, a, eur } = await fx();
    seedImportedTransaction(user.id, a.id, {
      amount: m(-100),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const [pending] = listNeedsAmount(user.id);
    getDB()
      .update(accounts)
      .set({ fillFromTransfers: false })
      .where(eq(accounts.id, eur.id))
      .run();
    expect(() =>
      resolveNeedsAmount(user.id, pending!.transferId, m(90)),
    ).toThrow(/no longer filled/);
  });
});

describe("unlink and manual links", () => {
  it("unlinking a mirror deletes it and is remembered", async () => {
    const { user, b, send } = await setup();
    const out = send();
    linkTransfers(user.id, {});
    const transferId = allTransfers()[0]!.id;

    unlink(user.id, transferId);
    expect(rowsOf(b.id)).toEqual([]);
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        id: transferId,
        status: "dismissed",
        outTransactionId: out.id,
        inTransactionId: null,
      }),
    ]);
    expect(linkTransfers(user.id, {})).toEqual({
      paired: 0,
      mirrored: 0,
      needsAmount: 0,
    });
    expect(getTransaction(user.id, out.id).transfer).toBeNull();
    // idempotent
    unlink(user.id, transferId);
  });

  it("unlinking a pair keeps both rows and does not pair them again", async () => {
    const { user, b, send } = await setup({ fill: false });
    send();
    const into = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-10",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN,
    });
    linkTransfers(user.id, {});
    const row = allTransfers()[0]!;
    unlink(user.id, row.id);
    expect(rowsOf(b.id).map((r) => r.id)).toEqual([into.id]);
    expect(linkTransfers(user.id, {}).paired).toBe(0);

    // the user can still link them by hand
    expect(linkManually(user.id, row.outTransactionId!, into.id)).toEqual(
      expect.any(String),
    );
    expect(allTransfers()).toEqual([
      expect.objectContaining({ status: "linked", method: "manual" }),
    ]);
  });

  it("deleting a mirror goes through unlink", async () => {
    const { user, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;
    deleteTransaction(user.id, mirror.id);
    expect(rowsOf(b.id)).toEqual([]);
    expect(allTransfers()[0]!.status).toBe("dismissed");
    linkTransfers(user.id, {});
    expect(rowsOf(b.id)).toEqual([]);
  });

  it("links two rows by hand and validates them", async () => {
    const { user, a, b, send } = await setup({ fill: false });
    const out = send({ counterpartyIban: null });
    const into = seedImportedTransaction(user.id, b.id, {
      amount: m(9990),
      bookingDate: "2026-03-14",
    });
    const sameSign = seedImportedTransaction(user.id, b.id, {
      amount: m(-5),
    });
    const sameAccount = send({ amount: m(77) });

    expect(() => linkManually(user.id, out.id, out.id)).toThrow(/different/);
    expect(() => linkManually(user.id, out.id, sameSign.id)).toThrow(
      /one debit and one credit/,
    );
    expect(() => linkManually(user.id, sameAccount.id, out.id)).toThrow(
      /different accounts/,
    );
    expect(() => linkManually(user.id, into.id, out.id)).toThrow(
      /one debit and one credit/,
    );

    const id = linkManually(user.id, out.id, into.id);
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        id,
        status: "linked",
        method: "manual",
        outTransactionId: out.id,
        inTransactionId: into.id,
        fromAccountId: a.id,
        toAccountId: b.id,
      }),
    ]);
    const other = seedImportedTransaction(user.id, b.id, { amount: m(1) });
    expect(() => linkManually(user.id, out.id, other.id)).toThrow(
      /already part of a transfer/,
    );
    expect(getTransaction(user.id, out.id).transfer).toMatchObject({
      id,
      status: "linked",
      method: "manual",
      direction: "out",
      peerAccountId: b.id,
      peerAccountName: "Savings",
      peerTransactionId: into.id,
    });
  });

  it("replaces a pending amount when the real counter-row is linked by hand", async () => {
    const user = await createTestUser();
    const a = seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const eur = seedAccount(user.id, {
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const out = seedImportedTransaction(user.id, a.id, {
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    expect(listNeedsAmount(user.id)).toHaveLength(1);
    const real = seedImportedTransaction(user.id, eur.id, {
      amount: m(9300),
      currency: "EUR",
    });
    linkManually(user.id, out.id, real.id);
    expect(listNeedsAmount(user.id)).toEqual([]);
    expect(allTransfers()).toHaveLength(1);
  });
});

describe("transferCandidates", () => {
  it("lists opposite rows on other accounts, equal amounts first", async () => {
    const { user, a, b, send } = await setup({ fill: false });
    const out = send({ counterpartyIban: null });
    const exact = seedImportedTransaction(user.id, b.id, {
      amount: m(10000),
      bookingDate: "2026-03-14",
    });
    const nearer = seedImportedTransaction(user.id, b.id, {
      amount: m(9000),
      bookingDate: "2026-03-10",
    });
    seedImportedTransaction(user.id, b.id, {
      amount: m(10000),
      bookingDate: "2026-04-10",
    });
    seedImportedTransaction(user.id, b.id, {
      amount: m(-10000),
      bookingDate: "2026-03-10",
    });
    seedImportedTransaction(user.id, a.id, {
      amount: m(10000),
      bookingDate: "2026-03-10",
    });
    const taken = seedImportedTransaction(user.id, b.id, {
      amount: m(10000),
      bookingDate: "2026-03-10",
    });
    const partner = seedImportedTransaction(user.id, a.id, {
      amount: m(-1),
      bookingDate: "2026-03-10",
    });
    linkManually(user.id, partner.id, taken.id);

    const list = transferCandidates(user.id, out.id);
    expect(list.map((c) => c.id)).toEqual([exact.id, nearer.id]);
    expect(list[0]).toMatchObject({
      accountId: b.id,
      accountName: "Savings",
      exact: true,
      days: 4,
    });
    expect(list[1]).toMatchObject({ exact: false, days: 0 });
  });

  it("offers nothing for a mirror", async () => {
    const { user, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    expect(transferCandidates(user.id, rowsOf(b.id)[0]!.id)).toEqual([]);
  });
});

const manualInput = (
  over: Partial<Parameters<typeof createManualTransaction>[2]> = {},
) => ({
  bookingDate: "2026-03-11",
  valueDate: null,
  amount: m(10000),
  counterpartyName: null,
  counterpartyIban: EXAMPLE_IBAN,
  description: null,
  reference: null,
  note: null,
  ...over,
});

describe("replacing mirrors", () => {
  async function mirrored() {
    const ctx = await setup();
    ctx.send({ reference: "RF-1" });
    linkTransfers(ctx.user.id, {});
    const mirror = rowsOf(ctx.b.id)[0]!;
    return { ...ctx, mirror };
  }
  const incoming = (over = {}) => ({
    key: "r",
    bookingDate: "2026-03-11",
    amount: 10000,
    counterpartyIban: null,
    reference: null,
    description: null,
    ...over,
  });

  it("takes a row without a counterparty only with the same reference or a shared word", async () => {
    const { user, b, mirror } = await mirrored();
    const find = (over = {}) =>
      findReplacements(user.id, b.id, [incoming(over)]).get("r");
    expect(find()).toBeUndefined();
    expect(find({ description: "Cash deposit" })).toBeUndefined();
    expect(find({ reference: "RF-1" })).toBe(mirror.id);
    expect(find({ description: "Savings top-up" })).toBe(mirror.id);
  });

  it("leaves the mirror, flagged inside an imported period, when nothing ties the row to it", async () => {
    const { user, b, mirror } = await mirrored();
    seedImport(user.id, b.id, {
      statementFrom: "2026-03-01",
      statementTo: "2026-03-31",
    });
    expect(
      findReplacements(user.id, b.id, [incoming({ description: "Cash" })]).size,
    ).toBe(0);
    expect(getTransaction(user.id, mirror.id).mirrorOf).toMatchObject({
      noBankCounterpart: true,
    });
  });

  it("is replaced by a manual row that matches, which keeps the link", async () => {
    const { user, a, b, mirror } = await mirrored();
    const out = rowsOf(a.id)[0]!;
    const view = createManualTransaction(user.id, b.id, manualInput());
    expect(rowsOf(b.id).map((r) => r.id)).toEqual([view.id]);
    expect(rowsOf(b.id)[0]!.id).not.toBe(mirror.id);
    expect(allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        method: "paired",
        outTransactionId: out.id,
        inTransactionId: view.id,
      }),
    ]);
  });

  it("is kept when the manual row differs, or names another counterparty", async () => {
    const { user, b, mirror } = await mirrored();
    createManualTransaction(user.id, b.id, manualInput({ amount: m(9999) }));
    createManualTransaction(
      user.id,
      b.id,
      manualInput({ counterpartyIban: EXAMPLE_IBAN_THIRD }),
    );
    expect(rowsOf(b.id).some((r) => r.id === mirror.id)).toBe(true);
    expect(rowsOf(b.id)).toHaveLength(3);
  });

  it("takes over nothing from another user", async () => {
    const { user, b } = await mirrored();
    const other = await createTestUser();
    const theirs = seedAccount(other.id, { iban: FOREIGN_IBANS[0]! });
    createManualTransaction(
      other.id,
      theirs.id,
      manualInput({ counterpartyIban: null }),
    );
    expect(rowsOf(b.id)).toHaveLength(1);
    expect(rowsOf(b.id)[0]!.source).toBe("mirror");
    expect(user.id).not.toBe(other.id);
  });
});

describe("dismissed transfers", () => {
  it("count again in the month summary and the review once unlinked", async () => {
    const { user, send } = await setup();
    send();
    linkTransfers(user.id, {});
    expect(monthSummary(user.id, { month: "2026-03" }).totals).toEqual([]);
    unlink(user.id, allTransfers()[0]!.id);
    expect(monthSummary(user.id, { month: "2026-03" }).totals).toEqual([
      { currency: "CHF", income: 0, expenses: 10000, net: -10000 },
    ]);
    const review = yearReview(user.id, { year: 2026, today: "2026-12-31" });
    expect(review.excludedTransfers).toBe(0);
    expect(review.currencies).toHaveLength(1);
  });

  it("only turn the heuristic off for the rows they name", async () => {
    const { user, send } = await setup();
    send();
    send({ bookingDate: "2026-03-20", amount: m(-500) });
    linkTransfers(user.id, {});
    const first = allTransfers().find((t) => t.outTransactionId !== null)!;
    unlink(user.id, first.id);
    const totals = monthSummary(user.id, { month: "2026-03" }).totals;
    expect(totals).toHaveLength(1);
    expect(totals[0]!.expenses).toBeGreaterThan(0);
    expect(totals[0]!.expenses).toBeLessThan(10500);
  });
});

describe("keeping links valid", () => {
  const manualDebit = (userId: string, accountId: string, over = {}) =>
    createManualTransaction(
      userId,
      accountId,
      manualInput({
        amount: m(-10000),
        counterpartyIban: EXAMPLE_IBAN_OTHER,
        bookingDate: "2026-03-10",
        ...over,
      }),
    );
  const edit = (view: ReturnType<typeof getTransaction>, over = {}) => ({
    bookingDate: view.bookingDate,
    valueDate: view.valueDate,
    amount: view.amount,
    counterpartyName: view.counterpartyName,
    counterpartyIban: view.counterpartyIban,
    description: view.description,
    reference: view.reference,
    note: view.note,
    ...over,
  });

  it("drops a pair that no longer fits after the manual row was edited", async () => {
    const { user, a, b } = await setup({ fill: false });
    const real = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-11",
      amount: m(10000),
    });
    const out = manualDebit(user.id, a.id);
    expect(allTransfers()).toEqual([
      expect.objectContaining({ method: "paired", status: "linked" }),
    ]);
    // A text change keeps it.
    updateTransaction(user.id, out.id, edit(out, { description: "Rent" }));
    expect(allTransfers()).toHaveLength(1);
    // Another amount breaks it; both rows stay.
    updateTransaction(user.id, out.id, edit(out, { amount: m(-9000) }));
    expect(allTransfers()).toEqual([]);
    expect(getTransaction(user.id, real.id).transfer).toBeNull();
    expect(getTransaction(user.id, out.id).transfer).toBeNull();
    // Changing it back links the pair again.
    updateTransaction(user.id, out.id, edit(out));
    expect(allTransfers()).toHaveLength(1);
  });

  it("moves a pair to the account the edited IBAN now names", async () => {
    const { user, a, b } = await setup({ fill: false });
    const c = seedAccount(user.id, { name: "Third", iban: EXAMPLE_IBAN_THIRD });
    const realB = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-11",
      amount: m(10000),
    });
    const realC = seedImportedTransaction(user.id, c.id, {
      bookingDate: "2026-03-12",
      amount: m(10000),
    });
    const out = manualDebit(user.id, a.id);
    expect(allTransfers().map((t) => t.inTransactionId)).toEqual([realB.id]);
    updateTransaction(
      user.id,
      out.id,
      edit(out, { counterpartyIban: EXAMPLE_IBAN_THIRD }),
    );
    expect(getTransaction(user.id, realB.id).transfer).toBeNull();
    expect(allTransfers().map((t) => t.inTransactionId)).toEqual([realC.id]);
  });

  it("keeps a manual link through a text edit and drops it when the signs stop being opposite", async () => {
    const { user, a, b } = await setup({ fill: false });
    const out = manualDebit(user.id, a.id, { counterpartyIban: null });
    const into = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-30",
      amount: m(4000),
    });
    linkManually(user.id, out.id, into.id);
    updateTransaction(user.id, out.id, edit(out, { description: "x" }));
    expect(allTransfers()).toEqual([
      expect.objectContaining({ method: "manual", status: "linked" }),
    ]);
    updateTransaction(user.id, out.id, edit(out, { amount: m(500) }));
    expect(allTransfers()).toEqual([]);
  });

  it("drops mirrors and pairs when the receiving account's IBAN changes", async () => {
    const { user, a, b, send } = await setup();
    send();
    send({ bookingDate: "2026-03-20", amount: m(-700) });
    seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-21",
      amount: m(700),
    });
    linkTransfers(user.id, {});
    expect(allTransfers()).toHaveLength(2);
    const view = getAccount(user.id, b.id);
    updateAccount(user.id, b.id, {
      ...inputOf(view),
      iban: EXAMPLE_IBAN_THIRD,
    });
    expect(allTransfers()).toEqual([]);
    expect(rowsOf(b.id).every((r) => r.source !== "mirror")).toBe(true);
    // Rows naming the new IBAN link from now on.
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-04-01",
      amount: m(-100),
      counterpartyIban: EXAMPLE_IBAN_THIRD,
    });
    updateAccount(user.id, b.id, { ...inputOf(getAccount(user.id, b.id)) });
    expect(linkTransfers(user.id, {}).mirrored).toBe(1);
  });

  it("keeps links when an account is saved without a new IBAN", async () => {
    const { user, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    updateAccount(user.id, b.id, {
      ...inputOf(getAccount(user.id, b.id)),
      name: "Renamed",
    });
    expect(allTransfers()).toHaveLength(1);
  });

  it("deletes a mirror that has no transfer", async () => {
    const { user, b } = await setup();
    const orphan = seedImportedTransaction(user.id, b.id, {
      source: "mirror",
      externalId: "mirror:orphan",
      amount: m(100),
    });
    deleteTransaction(user.id, orphan.id);
    expect(rowsOf(b.id)).toEqual([]);
  });

  describe("foreign currency mirrors", () => {
    async function fxManual() {
      const user = await createTestUser();
      const a = seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
      const eur = seedAccount(user.id, {
        name: "Euro",
        currency: "EUR",
        iban: EXAMPLE_IBAN_OTHER,
        fillFromTransfers: true,
      });
      const out = manualDebit(user.id, a.id);
      const [pending] = listNeedsAmount(user.id);
      resolveNeedsAmount(user.id, pending!.transferId, m(9300));
      return { user, a, eur, out };
    }

    it("keeps a hand-resolved mirror, its amount, note and category, through an edit of the source", async () => {
      const { user, eur, out } = await fxManual();
      const mirror = rowsOf(eur.id)[0]!;
      const category = createCategory(user.id, {
        name: "Savings",
        kind: "expense",
        parentId: null,
        color: null,
        icon: null,
      });
      getDB()
        .update(transactions)
        .set({ note: "kept", categoryId: category.id })
        .where(eq(transactions.id, mirror.id))
        .run();
      updateTransaction(
        user.id,
        out.id,
        edit(out, { description: "Rent", bookingDate: "2026-03-11" }),
      );
      expect(rowsOf(eur.id)).toEqual([
        expect.objectContaining({
          id: mirror.id,
          amount: 9300,
          currency: "EUR",
          note: "kept",
          categoryId: category.id,
          description: "Rent",
          bookingDate: "2026-03-11",
        }),
      ]);
      expect(allTransfers()).toEqual([
        expect.objectContaining({ status: "linked", method: "mirrored" }),
      ]);
      expect(listNeedsAmount(user.id)).toEqual([]);
    });

    it("drops the mirror and asks again when the sign of the source flips", async () => {
      const { user, eur, out } = await fxManual();
      updateTransaction(user.id, out.id, edit(out, { amount: m(10000) }));
      expect(rowsOf(eur.id)).toEqual([]);
      expect(listNeedsAmount(user.id)).toHaveLength(1);
    });

    it("keeps the link of a taken-over mirror through revalidateLinks and a resync", async () => {
      const { user, a, eur, out } = await fxManual();
      const real = createManualTransaction(
        user.id,
        eur.id,
        manualInput({
          amount: m(9300),
          counterpartyIban: EXAMPLE_IBAN,
          bookingDate: "2026-03-11",
        }),
      );
      expect(rowsOf(eur.id).map((r) => r.id)).toEqual([real.id]);
      expect(allTransfers()).toEqual([
        expect.objectContaining({ method: "paired", status: "linked" }),
      ]);
      expect(revalidateLinks(user.id, eur.id, getDB())).toBe(0);
      expect(revalidateLinks(user.id, a.id, getDB())).toBe(0);
      updateTransaction(user.id, out.id, edit(out, { description: "x" }));
      expect(allTransfers()).toEqual([
        expect.objectContaining({ method: "paired", status: "linked" }),
      ]);
      expect(linkTransfers(user.id, {})).toMatchObject({
        mirrored: 0,
        needsAmount: 0,
      });
      expect(rowsOf(eur.id)).toHaveLength(1);
    });
  });

  describe("dismissed transfers and edits", () => {
    it("keeps a dismissed pair when only the IBAN changes", async () => {
      const { user, a, b } = await setup({ fill: false });
      const real = seedImportedTransaction(user.id, b.id, {
        bookingDate: "2026-03-11",
        amount: m(10000),
      });
      const out = manualDebit(user.id, a.id);
      unlink(user.id, allTransfers()[0]!.id);
      expect(allTransfers()).toEqual([
        expect.objectContaining({
          status: "dismissed",
          outTransactionId: out.id,
          inTransactionId: real.id,
        }),
      ]);
      const none = updateTransaction(
        user.id,
        out.id,
        edit(out, { counterpartyIban: null }),
      );
      updateTransaction(
        user.id,
        out.id,
        edit(none, { counterpartyIban: EXAMPLE_IBAN_OTHER }),
      );
      expect(allTransfers()).toEqual([
        expect.objectContaining({ status: "dismissed" }),
      ]);
      expect(getTransaction(user.id, real.id).transfer).toBeNull();
    });

    it("forgets a dismissed mirror only when the IBAN names another own account", async () => {
      const { user, a, b } = await setup();
      const c = seedAccount(user.id, {
        name: "Third",
        iban: EXAMPLE_IBAN_THIRD,
        fillFromTransfers: true,
      });
      const out = manualDebit(user.id, a.id);
      unlink(user.id, allTransfers()[0]!.id);
      expect(rowsOf(b.id)).toEqual([]);
      // A text edit or an IBAN that names nobody keeps the dismissal.
      const same = updateTransaction(
        user.id,
        out.id,
        edit(out, { description: "x" }),
      );
      expect(rowsOf(b.id)).toEqual([]);
      const none = updateTransaction(
        user.id,
        out.id,
        edit(same, { counterpartyIban: null }),
      );
      expect(allTransfers()).toEqual([
        expect.objectContaining({ status: "dismissed" }),
      ]);
      updateTransaction(
        user.id,
        out.id,
        edit(none, { counterpartyIban: EXAMPLE_IBAN_OTHER }),
      );
      expect(rowsOf(b.id)).toEqual([]);
      // Another own account is a new question.
      updateTransaction(
        user.id,
        out.id,
        edit(none, { counterpartyIban: EXAMPLE_IBAN_THIRD }),
      );
      expect(rowsOf(c.id)).toHaveLength(1);
      expect(allTransfers().filter((t) => t.status === "dismissed")).toEqual(
        [],
      );
    });
  });
});

describe("listing needs-amount rows", () => {
  it("lists every pending transfer, newest first, filtered by account, across users", async () => {
    const user = await createTestUser();
    const a = seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
    const eur = seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const usd = seedAccount(user.id, {
      name: "Dollar",
      currency: "USD",
      iban: EXAMPLE_IBAN_THIRD,
      fillFromTransfers: true,
    });
    for (const [date, iban, amount] of [
      ["2026-03-10", EXAMPLE_IBAN_OTHER, -100],
      ["2026-03-12", EXAMPLE_IBAN_THIRD, -200],
      ["2026-03-11", EXAMPLE_IBAN_OTHER, 300],
    ] as const) {
      seedImportedTransaction(user.id, a.id, {
        bookingDate: date,
        amount: m(amount),
        counterpartyIban: iban,
      });
    }
    linkTransfers(user.id, {});
    expect(listNeedsAmount(user.id).map((r) => r.bookingDate)).toEqual([
      "2026-03-12",
      "2026-03-11",
      "2026-03-10",
    ]);
    expect(listNeedsAmount(user.id, eur.id)).toHaveLength(2);
    expect(listNeedsAmount(user.id, usd.id)).toHaveLength(1);
    const other = await createTestUser();
    expect(listNeedsAmount(other.id)).toEqual([]);
  });
});

describe("another user's data", () => {
  it("is invisible to every transfer function", async () => {
    const { user, b, send } = await setup();
    const out = send();
    linkTransfers(user.id, {});
    const row = allTransfers()[0]!;
    const mirror = rowsOf(b.id)[0]!;
    const intruder = await createTestUser();
    const own = seedAccount(intruder.id, { name: "Own" });
    const mine = seedImportedTransaction(intruder.id, own.id, {
      amount: m(10000),
    });

    const notFound = /not found/i;
    expect(() => unlink(intruder.id, row.id)).toThrow(notFound);
    expect(() => resolveNeedsAmount(intruder.id, row.id, m(1))).toThrow(
      notFound,
    );
    expect(() => linkManually(intruder.id, out.id, mine.id)).toThrow(notFound);
    expect(() => linkManually(intruder.id, mine.id, mirror.id)).toThrow(
      notFound,
    );
    expect(() => transferCandidates(intruder.id, out.id)).toThrow(notFound);
    expect(() => fillSuggestion(intruder.id, b.id)).toThrow(notFound);
    expect(() => enableFill(intruder.id, b.id)).toThrow(notFound);
    expect(listNeedsAmount(intruder.id)).toEqual([]);
    expect(countMirrors(intruder.id, b.id)).toBe(0);
    expect(() => getTransaction(intruder.id, mirror.id)).toThrow(notFound);
    expect(allTransfers()).toHaveLength(1);
  });
});

describe("transaction views", () => {
  it("describe mirrors and transfers", async () => {
    const { user, a, b, send } = await setup();
    const out = send();
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;

    const view = getTransaction(user.id, mirror.id);
    expect(view.source).toBe("mirror");
    expect(view.mirrorOf).toEqual({
      transactionId: out.id,
      accountId: a.id,
      accountName: "Main",
      noBankCounterpart: false,
    });
    expect(view.transfer).toMatchObject({
      status: "linked",
      method: "mirrored",
      direction: "in",
      peerAccountId: a.id,
      peerAccountName: "Main",
      peerTransactionId: out.id,
    });
    const source = getTransaction(user.id, out.id);
    expect(source.mirrorOf).toBeNull();
    expect(source.transfer).toMatchObject({
      direction: "out",
      peerAccountId: b.id,
      peerTransactionId: mirror.id,
    });
    const page = listTransactions(user.id, b.id);
    expect(page.items[0]).toMatchObject({
      id: mirror.id,
      mirrorOf: { transactionId: out.id },
    });
  });

  it("flags a mirror inside an imported statement period", async () => {
    const { user, b, send } = await setup();
    send();
    send({ bookingDate: "2026-05-02" });
    linkTransfers(user.id, {});
    seedImport(user.id, b.id, {
      statementFrom: "2026-03-01",
      statementTo: "2026-03-31",
    });
    const flags = Object.fromEntries(
      rowsOf(b.id).map((r) => [
        r.bookingDate,
        getTransaction(user.id, r.id).mirrorOf!.noBankCounterpart,
      ]),
    );
    expect(flags).toEqual({ "2026-03-10": true, "2026-05-02": false });
  });

  it("make mirrors read-only except for the note and the category", async () => {
    const { user, b, send } = await setup();
    send();
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;
    const view = updateTransaction(user.id, mirror.id, { note: "check" });
    expect(view).toMatchObject({ note: "check", amount: 10000 });
    expect(() =>
      updateTransaction(user.id, mirror.id, {
        bookingDate: "2026-03-11",
        valueDate: null,
        amount: m(1),
        counterpartyName: null,
        counterpartyIban: null,
        description: null,
        reference: null,
        note: null,
      }),
    ).not.toThrow();
    expect(getTransaction(user.id, mirror.id)).toMatchObject({
      bookingDate: "2026-03-10",
      amount: 10000,
    });
  });
});

describe("consumers", () => {
  it("leave linked transfers out of the month summary, with the IBAN fallback for the rest", async () => {
    const { user, b, send } = await setup();
    send({ counterpartyIban: null });
    const noIbanIn = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-10",
      amount: m(10000),
    });
    send({ bookingDate: "2026-03-12", amount: m(-300) });
    seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-20",
      amount: m(-40),
      counterpartyIban: EXAMPLE_IBAN_THIRD,
    });
    const before = monthSummary(user.id, { month: "2026-03" }).totals;
    expect(before).toEqual([
      { currency: "CHF", income: 10000, expenses: 10040, net: -40 },
    ]);

    const first = getDB()
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.bookingDate, "2026-03-10"),
          eq(transactions.amount, m(-10000)),
        ),
      )
      .get()!;
    linkManually(user.id, first.id, noIbanIn.id);
    // The other row names an own IBAN: the heuristic still excludes it.
    expect(monthSummary(user.id, { month: "2026-03" }).totals).toEqual([
      { currency: "CHF", income: 0, expenses: 40, net: -40 },
    ]);
  });

  it("do not count a mirror or its source in the month summary or the review", async () => {
    const { user, send } = await setup();
    send();
    linkTransfers(user.id, {});
    expect(monthSummary(user.id, { month: "2026-03" }).totals).toEqual([]);
    const review = yearReview(user.id, { year: 2026, today: "2026-12-31" });
    expect(review.currencies).toEqual([]);
    expect(review.excludedTransfers).toBeGreaterThanOrEqual(1);
  });

  it("exclude linked pairs without IBANs from the month summary and the review", async () => {
    const user = await createTestUser();
    const a = seedAccount(user.id, { name: "A" });
    const b = seedAccount(user.id, { name: "B" });
    const out = seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-2000),
    });
    const into = seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-10",
      amount: m(2000),
    });
    expect(monthSummary(user.id, { month: "2026-03" }).totals[0]).toMatchObject(
      {
        income: 2000,
        expenses: 2000,
      },
    );
    linkManually(user.id, out.id, into.id);
    expect(monthSummary(user.id, { month: "2026-03" }).totals).toEqual([]);
    const review = yearReview(user.id, { year: 2026, today: "2026-12-31" });
    expect(review.excludedTransfers).toBe(2);
    expect(review.currencies).toEqual([]);
  });

  it("leave linked transfers out of budgets and spending", async () => {
    const { user, a, b, send } = await setup();
    const food = createCategory(user.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    send({ categoryId: food.id });
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-11",
      amount: m(-700),
      categoryId: food.id,
    });
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-12",
      amount: m(-50),
    });
    expect(spendingByCategory(user.id, "2026-03").currencies[0]!.total).toBe(
      10700,
    );
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;
    getDB()
      .update(transactions)
      .set({ categoryId: food.id })
      .where(eq(transactions.id, mirror.id))
      .run();
    const spending = spendingByCategory(user.id, "2026-03");
    expect(spending.currencies[0]!.total).toBe(700);
    expect(spending.uncategorizedCount).toBe(1);
  });

  it("never categorize mirrors by rule", async () => {
    const { user, b, send } = await setup();
    const cat = createCategory(user.id, {
      name: "Moves",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    createRule(user.id, {
      categoryId: cat.id,
      priority: 0,
      counterpartyContains: null,
      descriptionContains: "savings",
      counterpartyIban: null,
      amountSign: null,
    });
    const out = send();
    linkTransfers(user.id, {});
    expect(applyRulesToUncategorized(user.id)).toMatchObject({
      categorized: 1,
    });
    expect(getTransaction(user.id, out.id).categoryId).toBe(cat.id);
    expect(getTransaction(user.id, rowsOf(b.id)[0]!.id).categoryId).toBeNull();
  });

  it("skip mirrors when detecting recurring payments", async () => {
    const { user, b, send } = await setup();
    for (const month of ["01", "02", "03"]) {
      send({
        bookingDate: `2026-${month}-05`,
        amount: m(-5000),
        counterpartyName: "Savings plan",
      });
    }
    linkTransfers(user.id, {});
    expect(rowsOf(b.id)).toHaveLength(3);
    syncRecurring(user.id);
    const series = listRecurring(user.id, "2026-04-01");
    expect(series).toHaveLength(1);
    expect(series[0]!.lastAmount).toBe(-5000);
  });

  it("keep mirrors out of bill matching", async () => {
    const { user, a, b } = await setup();
    const reference = makeQrr(42);
    const bill = seedBill(user.id, {
      amount: m(10000),
      reference,
      referenceType: "QRR",
      creditorIban: EXAMPLE_IBAN_THIRD,
    });
    // An outgoing transfer carrying a bill's reference: its mirror is a credit, never a payment.
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      reference,
      referenceType: "QRR",
    });
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;
    expect(mirror.amount).toBe(-10000);
    expect(
      getSuggestions(user.id, { billId: bill.id }).map((s) => s.transactionId),
    ).not.toContain(mirror.id);
    expect(
      candidateTransactions(user.id, bill.id).items.map((c) => c.id),
    ).not.toContain(mirror.id);
    expect(() =>
      allocate(user.id, bill.id, mirror.id, m(10000), "user"),
    ).toThrow(/mirrored transfer/);
    expect(unmatchedTransactions(user.id, { today: "2026-03-20" }).count).toBe(
      0,
    );
  });

  it("keep mirrors out of tax suggestions, tagging and deductions", async () => {
    const { user, b, send } = await setup();
    send({
      bookingDate: "2025-03-09",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;
    expect(mirror.amount).toBe(-10000);

    upsertTaxYear(
      user.id,
      taxYearInputSchema.parse({
        year: "2025",
        authority: "Example Tax Office",
        currency: "CHF",
        assessedTotal: "",
        notes: "",
      }),
    );
    addTaxCredit(
      user.id,
      2025,
      taxCreditInputSchema("CHF").parse({
        bookingDate: "2025-03-11",
        amount: "100.00",
        reference: "",
        description: "",
      }),
    );
    const rec = reconcileYear(user.id, 2025)!;
    expect(rec.suggestions.map((s) => s.transactionId)).not.toContain(
      mirror.id,
    );

    const cat = createCategory(user.id, {
      name: "Gifts",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    setCategoryDeduction(user.id, cat.id, "donations");
    getDB()
      .update(transactions)
      .set({ categoryId: cat.id })
      .where(eq(transactions.id, mirror.id))
      .run();
    expect(deductionSummary(user.id, 2025).totals).toEqual([]);

    expect(() => setTransactionTaxYear(user.id, mirror.id, 2025)).toThrow(
      /mirrored transfer/,
    );
    expect(() => setTransactionDeductionYear(user.id, mirror.id, 2025)).toThrow(
      /mirrored transfer/,
    );
    expect(() =>
      setTransactionDeductionExcluded(user.id, mirror.id, true),
    ).toThrow(/mirrored transfer/);
  });

  it("keep mirrors out of pillar 3a contribution detection", async () => {
    const { user, b, send } = await setup();
    const p3a = seedPillar3aAccount(user.id);
    const reference = makeQrr(7);
    seedPortfolio(user.id, p3a.id, { depositReference: reference });
    send({
      amount: m(10000),
      reference,
      referenceType: "QRR",
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    linkTransfers(user.id, {});
    const mirror = rowsOf(b.id)[0]!;
    expect(mirror.reference).toBe(reference);
    expect(detectedContributions(user.id)).toEqual([]);
  });
});
