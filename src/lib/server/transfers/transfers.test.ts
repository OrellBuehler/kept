import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  accounts,
  first,
  getDB,
  transactions,
  transfers,
  transaction,
} from "$lib/server/db";
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
  countMirrorsInTx,
  enableFill,
  findReplacements,
  findReplacementsInTx,
  linkAfterWrite,
  fillSuggestion,
  linkManually,
  linkNeedsAmountTo,
  linkTransfers,
  linkTransfersInTx,
  listNeedsAmount,
  loadPlanAccounts,
  loadPlanAccountsInTx,
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
  const a = await seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
  const b = await seedAccount(user.id, {
    name: "Savings",
    type: "savings",
    iban: EXAMPLE_IBAN_OTHER,
    fillFromTransfers: over.fill ?? true,
  });
  const send = async (
    over: Parameters<typeof seedImportedTransaction>[2] = {},
  ) =>
    seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      description: "Move to savings",
      ...over,
    });
  return { user, a, b, send };
}

const inputOf = (view: Awaited<ReturnType<typeof getAccount>>) => ({
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

const rowsOf = async (accountId: string) =>
  getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
const allTransfers = async () => getDB().select().from(transfers);

describe("linkTransfers", () => {
  it("mirrors a transfer onto an account filled from transfers", async () => {
    const { user, a, b, send } = await setup();
    const out = await send({
      valueDate: "2026-03-11",
      reference: EXAMPLE_SCOR,
    });

    expect(await linkTransfers(user.id, { transactionIds: [out.id] })).toEqual({
      paired: 0,
      mirrored: 1,
      needsAmount: 0,
    });
    const [mirror] = await rowsOf(b.id);
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
    expect(await allTransfers()).toEqual([
      expect.objectContaining({
        outTransactionId: out.id,
        inTransactionId: mirror!.id,
        status: "linked",
        method: "mirrored",
        fromAccountId: a.id,
        toAccountId: b.id,
      }),
    ]);
    expect((await getAccount(user.id, b.id, "2026-12-31")).balance).toBe(10000);
  });

  it("mirrors an incoming payment as a debit and is idempotent", async () => {
    const { user, a, b, send } = await setup();
    const into = await send({ amount: m(2500) });
    await linkTransfers(user.id, {});
    expect(await linkTransfers(user.id, {})).toEqual({
      paired: 0,
      mirrored: 0,
      needsAmount: 0,
    });
    expect(await rowsOf(b.id)).toHaveLength(1);
    expect((await rowsOf(b.id))[0]!.amount).toBe(-2500);
    expect((await allTransfers())[0]).toMatchObject({
      inTransactionId: into.id,
      fromAccountId: b.id,
      toAccountId: a.id,
    });
  });

  it("pairs two real rows and creates no mirror", async () => {
    const { user, a, b, send } = await setup();
    const out = await send();
    const into = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-12",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN,
    });
    expect(await linkTransfers(user.id, {})).toMatchObject({
      paired: 1,
      mirrored: 0,
    });
    expect(await rowsOf(b.id)).toHaveLength(1);
    expect((await allTransfers())[0]).toMatchObject({
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
    const one = await send();
    const two = await send({ bookingDate: "2026-04-10" });
    expect(
      (await linkTransfers(user.id, { transactionIds: [one.id] })).mirrored,
    ).toBe(1);
    expect(
      (await linkTransfers(user.id, { sourceAccountId: b.id })).mirrored,
    ).toBe(0);
    expect(
      (
        await linkTransfers(user.id, {
          targetAccountId: b.id,
          to: "2026-03-31",
        })
      ).mirrored,
    ).toBe(0);
    expect(
      (await linkTransfers(user.id, { targetAccountId: b.id })).mirrored,
    ).toBe(1);
    expect((await rowsOf(b.id)).map((r) => r.mirrorOfId).sort()).toEqual(
      [one.id, two.id].sort(),
    );
  });

  it("creates no mirror when the toggle is off, and enabling backfills", async () => {
    const { user, b, send } = await setup({ fill: false });
    await send();
    await send({ bookingDate: "2026-04-10", amount: m(-500) });
    expect((await linkTransfers(user.id, {})).mirrored).toBe(0);
    expect(await fillSuggestion(user.id, b.id)).toEqual({ count: 2 });

    expect(await enableFill(user.id, b.id)).toMatchObject({ mirrored: 2 });
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(true);
    expect(await rowsOf(b.id)).toHaveLength(2);
    expect(await fillSuggestion(user.id, b.id)).toBeNull();
  });

  it("refuses to enable filling on an archived account and offers no suggestion for it", async () => {
    const { user, b, send } = await setup({ fill: false });
    await send();
    await setAccountArchived(user.id, b.id, true);
    expect(await fillSuggestion(user.id, b.id)).toBeNull();
    await expect(enableFill(user.id, b.id)).rejects.toThrow(/archived/i);
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(false);
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("needs the removal confirmed when the toggle goes off on an account with mirrors", async () => {
    const { user, b, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    const off = {
      ...inputOf(await getAccount(user.id, b.id)),
      fillFromTransfers: false,
    };
    await expect(updateAccount(user.id, b.id, off)).rejects.toThrow(
      expect.objectContaining({ code: "invalid", field: "fillFromTransfers" }),
    );
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(true);
    expect(await rowsOf(b.id)).toHaveLength(1);
    await updateAccount(user.id, b.id, { ...off, confirmRemoveMirrors: true });
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(false);
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("turns the toggle off without confirmation when there are no mirrors", async () => {
    const { user, b } = await setup();
    await updateAccount(user.id, b.id, {
      ...inputOf(await getAccount(user.id, b.id)),
      fillFromTransfers: false,
    });
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(false);
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
    await send();
    const view = await getAccount(user.id, b.id);
    await updateAccount(user.id, b.id, {
      ...inputOf(view),
      fillFromTransfers: true,
    });
    expect(await countMirrors(user.id, b.id)).toBe(1);

    await updateAccount(user.id, b.id, {
      ...inputOf(await getAccount(user.id, b.id)),
      fillFromTransfers: false,
      confirmRemoveMirrors: true,
    });
    expect(await countMirrors(user.id, b.id)).toBe(0);
    expect(await allTransfers()).toEqual([]);
  });

  it("removes mirrors and pending amounts when filling is turned off", async () => {
    const { user, b, send } = await setup();
    const eur = await seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_THIRD,
      fillFromTransfers: true,
    });
    await send();
    await send({
      counterpartyIban: EXAMPLE_IBAN_THIRD,
      bookingDate: "2026-03-11",
    });
    await linkTransfers(user.id, {});
    expect(await listNeedsAmount(user.id, eur.id)).toHaveLength(1);

    await transaction(async (tx) => removeMirrors(tx, user.id, eur.id));
    expect(await listNeedsAmount(user.id)).toEqual([]);
    expect(await countMirrors(user.id, b.id)).toBe(1);
  });

  it("never mirrors before the opening date or onto pillar 3a and portfolio accounts", async () => {
    const { user, send } = await setup({ fill: false });
    const dated = await seedAccount(user.id, {
      name: "Dated",
      iban: EXAMPLE_IBAN_THIRD,
      openingDate: "2026-03-11",
      fillFromTransfers: true,
    });
    await send({
      counterpartyIban: EXAMPLE_IBAN_THIRD,
      bookingDate: "2026-03-10",
    });
    expect((await linkTransfers(user.id, {})).mirrored).toBe(0);
    await send({
      counterpartyIban: EXAMPLE_IBAN_THIRD,
      bookingDate: "2026-03-11",
    });
    expect((await linkTransfers(user.id, {})).mirrored).toBe(1);
    expect(await countMirrors(user.id, dated.id)).toBe(1);

    const p3a = await seedPillar3aAccount(user.id, {
      iban: FOREIGN_IBANS[0]!,
      fillFromTransfers: true,
    });
    expect((await getAccount(user.id, p3a.id)).fillFromTransfers).toBe(false);
    await getDB()
      .update(accounts)
      .set({ fillFromTransfers: true })
      .where(eq(accounts.id, p3a.id));
    await seedPortfolio(user.id, p3a.id);
    await send({ counterpartyIban: FOREIGN_IBANS[0]! });
    expect((await linkTransfers(user.id, {})).mirrored).toBe(0);
    await expect(enableFill(user.id, p3a.id)).rejects.toThrow(LedgerError);
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
    await send();
    await linkTransfers(user.id, {});
    const input = {
      ...inputOf(await getAccount(user.id, b.id)),
      fillFromTransfers: undefined,
    };
    await updateAccount(user.id, b.id, { ...input, name: "Renamed" });
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(true);
    expect(await rowsOf(b.id)).toHaveLength(1);
    await updateAccount(user.id, b.id, {
      ...input,
      fillFromTransfers: false,
      confirmRemoveMirrors: true,
    });
    expect((await getAccount(user.id, b.id)).fillFromTransfers).toBe(false);
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("recognises archived accounts and ignores deposit IBANs", async () => {
    const { user, b, send } = await setup();
    await send();
    await setAccountArchived(user.id, b.id, true);
    expect((await ownIbans(user.id)).get(EXAMPLE_IBAN_OTHER)).toBe(b.id);
    // Still addressable, but nothing new is mirrored onto it.
    expect((await linkTransfers(user.id, {})).mirrored).toBe(0);
    expect(await rowsOf(b.id)).toEqual([]);
    await setAccountArchived(user.id, b.id, false);
    expect((await linkTransfers(user.id, {})).mirrored).toBe(1);

    const p3a = await seedPillar3aAccount(user.id, {
      depositIban: EXAMPLE_IBAN_THIRD,
    });
    expect([...(await ownIbans(user.id)).values()]).not.toContain(p3a.id);
    expect((await ownIbans(user.id)).has(EXAMPLE_IBAN_THIRD)).toBe(false);
  });

  it("removes the mirror and its transfer with the source row or its import", async () => {
    const { user, a, b, send } = await setup();
    const imp = await seedImport(user.id, a.id);
    const fromImport = await send({ importId: imp.id });
    const manual = await send({
      source: "manual",
      externalId: "manual:1",
      bookingDate: "2026-03-20",
    });
    await linkTransfers(user.id, {});
    expect(await rowsOf(b.id)).toHaveLength(2);

    await undoImport(user.id, imp.id);
    expect((await rowsOf(a.id)).map((r) => r.id)).toEqual([manual.id]);
    expect(await rowsOf(b.id)).toHaveLength(1);
    expect((await rowsOf(a.id)).some((r) => r.id === fromImport.id)).toBe(
      false,
    );

    await deleteTransaction(user.id, manual.id);
    expect(await rowsOf(b.id)).toEqual([]);
    expect(await allTransfers()).toEqual([]);
  });

  it("removes mirrors and transfers when the source account is deleted", async () => {
    const { user, a, b, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    expect(await rowsOf(b.id)).toHaveLength(1);
    await deleteAccount(user.id, a.id);
    expect(await rowsOf(b.id)).toEqual([]);
    expect(await allTransfers()).toEqual([]);
  });

  it("keeps working when the same IBAN belongs to another user", async () => {
    const { user, b, send } = await setup();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, {
      name: "Theirs",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    await send();
    expect(await linkTransfers(other.id, {})).toEqual({
      paired: 0,
      mirrored: 0,
      needsAmount: 0,
    });
    expect(await rowsOf(theirs.id)).toEqual([]);
    expect((await linkTransfers(user.id, {})).mirrored).toBe(1);
    expect(await rowsOf(theirs.id)).toEqual([]);
    expect(await rowsOf(b.id)).toHaveLength(1);
  });
});

describe("foreign currency transfers", () => {
  async function fx() {
    const user = await createTestUser();
    const a = await seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
    const eur = await seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    return { user, a, eur };
  }

  it("uses the statement's counter-amount", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      originalAmount: m(-9300),
      originalCurrency: "EUR",
    });
    await linkTransfers(user.id, {});
    expect((await rowsOf(eur.id))[0]).toMatchObject({
      amount: 9300,
      currency: "EUR",
      source: "mirror",
    });
  });

  it("lists the transfer as needing an amount, then creates the mirror", async () => {
    const { user, a, eur } = await fx();
    const out = await seedImportedTransaction(user.id, a.id, {
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      description: "Move",
    });
    expect(await linkTransfers(user.id, {})).toMatchObject({
      mirrored: 0,
      needsAmount: 1,
    });
    expect(await rowsOf(eur.id)).toEqual([]);
    const [pending] = await listNeedsAmount(user.id, eur.id);
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
    expect(await listNeedsAmount(user.id, a.id)).toEqual([]);
    expect((await getTransaction(user.id, out.id)).transfer).toMatchObject({
      status: "needs_amount",
      peerAccountId: eur.id,
      peerTransactionId: null,
    });

    await resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect((await rowsOf(eur.id))[0]).toMatchObject({
      amount: 9300,
      currency: "EUR",
    });
    expect((await allTransfers())[0]).toMatchObject({
      status: "linked",
      method: "mirrored",
      outTransactionId: out.id,
    });
    expect(await listNeedsAmount(user.id)).toEqual([]);
    await expect(
      resolveNeedsAmount(user.id, pending!.transferId, m(1)),
    ).rejects.toThrow(/needs no amount/);
  });

  it("books an incoming FX transfer as a debit and rejects bad amounts", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      amount: m(5000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const [pending] = await listNeedsAmount(user.id);
    expect(pending).toMatchObject({
      direction: "out",
      targetAccountId: eur.id,
    });
    await expect(
      resolveNeedsAmount(user.id, pending!.transferId, m(0)),
    ).rejects.toThrow(LedgerError);
    await expect(
      resolveNeedsAmount(user.id, pending!.transferId, m(-3)),
    ).rejects.toThrow(LedgerError);
    await resolveNeedsAmount(user.id, pending!.transferId, m(4600));
    expect((await rowsOf(eur.id))[0]!.amount).toBe(-4600);
    expect((await allTransfers())[0]).toMatchObject({
      inTransactionId: expect.any(String),
      outTransactionId: (await rowsOf(eur.id))[0]!.id,
    });
  });

  const euroCredit = async (
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
    const out = await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    expect((await linkTransfers(user.id, {})).needsAmount).toBe(1);
    const credit = await euroCredit(user, eur.id);
    const result = await transaction(async (tx) =>
      linkAfterWrite(tx, user.id, eur.id, [credit.id], [credit.bookingDate]),
    );
    expect(result).toMatchObject({ paired: 1, needsAmount: 0, mirrored: 0 });
    expect(await listNeedsAmount(user.id)).toEqual([]);
    expect(await allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        method: "paired",
        outTransactionId: out.id,
        inTransactionId: credit.id,
      }),
    ]);
    expect(await rowsOf(eur.id)).toHaveLength(1);
  });

  it("pairs the same two rows within one run, the debit dated earlier", async () => {
    const { user, a, eur } = await fx();
    const out = await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-09",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    const credit = await euroCredit(user, eur.id);
    expect(await linkTransfers(user.id, {})).toMatchObject({
      paired: 1,
      needsAmount: 0,
      mirrored: 0,
    });
    expect(await allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        outTransactionId: out.id,
        inTransactionId: credit.id,
      }),
    ]);
    expect(await rowsOf(eur.id)).toHaveLength(1);
  });

  it("refuses to resolve while the receiving account has an unlinked opposite row near the date", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const [pending] = await listNeedsAmount(user.id);
    const near = await seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
    });
    await expect(
      resolveNeedsAmount(user.id, pending!.transferId, m(9300)),
    ).rejects.toThrow(/link/i);
    expect(await rowsOf(eur.id)).toHaveLength(1);
    // Once that row is part of another transfer it no longer blocks.
    const other = await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-30",
      amount: m(-9000),
    });
    await linkManually(user.id, other.id, near.id);
    await resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect(await rowsOf(eur.id)).toHaveLength(2);
  });

  it("only lets a row that names no other account block resolving, and says which one", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const [pending] = await listNeedsAmount(user.id);
    expect(pending!.linkCandidate).toBeNull();
    // Another payment: it names someone else.
    await seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
      counterpartyIban: EXAMPLE_IBAN_THIRD,
    });
    expect((await listNeedsAmount(user.id))[0]!.linkCandidate).toBeNull();
    await resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect(await rowsOf(eur.id)).toHaveLength(2);
  });

  it("names the row to link when resolving is refused, and links it instead", async () => {
    const { user, a, eur } = await fx();
    const out = await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const near = await seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
      counterpartyIban: EXAMPLE_IBAN,
    });
    const [pending] = await listNeedsAmount(user.id);
    expect(pending!.linkCandidate).toMatchObject({
      id: near.id,
      bookingDate: "2026-03-12",
    });
    await expect(
      resolveNeedsAmount(user.id, pending!.transferId, m(9300)),
    ).rejects.toThrow(
      expect.objectContaining({ code: "conflict", candidateId: near.id }),
    );
    await linkNeedsAmountTo(user.id, pending!.transferId, near.id);
    expect(await listNeedsAmount(user.id)).toEqual([]);
    expect(await allTransfers()).toEqual([
      expect.objectContaining({
        status: "linked",
        method: "manual",
        outTransactionId: out.id,
        inTransactionId: near.id,
      }),
    ]);
    expect(await rowsOf(eur.id)).toHaveLength(1);
  });

  it("links a needs-amount transfer only to rows of the receiving account and only for its owner", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const [pending] = await listNeedsAmount(user.id);
    const wrong = await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-12",
      amount: m(500),
    });
    await expect(
      linkNeedsAmountTo(user.id, pending!.transferId, wrong.id),
    ).rejects.toThrow(LedgerError);
    const right = await seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-12",
      amount: m(9000),
      currency: "EUR",
    });
    const other = await createTestUser();
    await expect(
      linkNeedsAmountTo(other.id, pending!.transferId, right.id),
    ).rejects.toThrow(expect.objectContaining({ code: "not_found" }));
    expect(await listNeedsAmount(user.id)).toHaveLength(1);
  });

  it("does not let a far-away or same-direction row block resolving", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    await seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-20",
      amount: m(9000),
      currency: "EUR",
    });
    await seedImportedTransaction(user.id, eur.id, {
      bookingDate: "2026-03-11",
      amount: m(-9000),
      currency: "EUR",
    });
    const [pending] = await listNeedsAmount(user.id);
    await resolveNeedsAmount(user.id, pending!.transferId, m(9300));
    expect((await allTransfers())[0]).toMatchObject({ status: "linked" });
  });

  it("refuses to resolve once filling was turned off", async () => {
    const { user, a, eur } = await fx();
    await seedImportedTransaction(user.id, a.id, {
      amount: m(-100),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const [pending] = await listNeedsAmount(user.id);
    await getDB()
      .update(accounts)
      .set({ fillFromTransfers: false })
      .where(eq(accounts.id, eur.id));
    await expect(
      resolveNeedsAmount(user.id, pending!.transferId, m(90)),
    ).rejects.toThrow(/no longer filled/);
  });
});

describe("unlink and manual links", () => {
  it("unlinking a mirror deletes it and is remembered", async () => {
    const { user, b, send } = await setup();
    const out = await send();
    await linkTransfers(user.id, {});
    const transferId = (await allTransfers())[0]!.id;

    await unlink(user.id, transferId);
    expect(await rowsOf(b.id)).toEqual([]);
    expect(await allTransfers()).toEqual([
      expect.objectContaining({
        id: transferId,
        status: "dismissed",
        outTransactionId: out.id,
        inTransactionId: null,
      }),
    ]);
    expect(await linkTransfers(user.id, {})).toEqual({
      paired: 0,
      mirrored: 0,
      needsAmount: 0,
    });
    expect((await getTransaction(user.id, out.id)).transfer).toBeNull();
    // idempotent
    await unlink(user.id, transferId);
  });

  it("unlinking a pair keeps both rows and does not pair them again", async () => {
    const { user, b, send } = await setup({ fill: false });
    await send();
    const into = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-10",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN,
    });
    await linkTransfers(user.id, {});
    const row = (await allTransfers())[0]!;
    await unlink(user.id, row.id);
    expect((await rowsOf(b.id)).map((r) => r.id)).toEqual([into.id]);
    expect((await linkTransfers(user.id, {})).paired).toBe(0);

    // the user can still link them by hand
    expect(await linkManually(user.id, row.outTransactionId!, into.id)).toEqual(
      expect.any(String),
    );
    expect(await allTransfers()).toEqual([
      expect.objectContaining({ status: "linked", method: "manual" }),
    ]);
  });

  it("deleting a mirror goes through unlink", async () => {
    const { user, b, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    await deleteTransaction(user.id, mirror.id);
    expect(await rowsOf(b.id)).toEqual([]);
    expect((await allTransfers())[0]!.status).toBe("dismissed");
    await linkTransfers(user.id, {});
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("links two rows by hand and validates them", async () => {
    const { user, a, b, send } = await setup({ fill: false });
    const out = await send({ counterpartyIban: null });
    const into = await seedImportedTransaction(user.id, b.id, {
      amount: m(9990),
      bookingDate: "2026-03-14",
    });
    const sameSign = await seedImportedTransaction(user.id, b.id, {
      amount: m(-5),
    });
    const sameAccount = await send({ amount: m(77) });

    await expect(linkManually(user.id, out.id, out.id)).rejects.toThrow(
      /different/,
    );
    await expect(linkManually(user.id, out.id, sameSign.id)).rejects.toThrow(
      /one debit and one credit/,
    );
    await expect(linkManually(user.id, sameAccount.id, out.id)).rejects.toThrow(
      /different accounts/,
    );
    await expect(linkManually(user.id, into.id, out.id)).rejects.toThrow(
      /one debit and one credit/,
    );

    const id = await linkManually(user.id, out.id, into.id);
    expect(await allTransfers()).toEqual([
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
    const other = await seedImportedTransaction(user.id, b.id, {
      amount: m(1),
    });
    await expect(linkManually(user.id, out.id, other.id)).rejects.toThrow(
      /already part of a transfer/,
    );
    expect((await getTransaction(user.id, out.id)).transfer).toMatchObject({
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
    const a = await seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const eur = await seedAccount(user.id, {
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const out = await seedImportedTransaction(user.id, a.id, {
      amount: m(-10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    expect(await listNeedsAmount(user.id)).toHaveLength(1);
    const real = await seedImportedTransaction(user.id, eur.id, {
      amount: m(9300),
      currency: "EUR",
    });
    await linkManually(user.id, out.id, real.id);
    expect(await listNeedsAmount(user.id)).toEqual([]);
    expect(await allTransfers()).toHaveLength(1);
  });
});

describe("transferCandidates", () => {
  it("lists opposite rows on other accounts, equal amounts first", async () => {
    const { user, a, b, send } = await setup({ fill: false });
    const out = await send({ counterpartyIban: null });
    const exact = await seedImportedTransaction(user.id, b.id, {
      amount: m(10000),
      bookingDate: "2026-03-14",
    });
    const nearer = await seedImportedTransaction(user.id, b.id, {
      amount: m(9000),
      bookingDate: "2026-03-10",
    });
    await seedImportedTransaction(user.id, b.id, {
      amount: m(10000),
      bookingDate: "2026-04-10",
    });
    await seedImportedTransaction(user.id, b.id, {
      amount: m(-10000),
      bookingDate: "2026-03-10",
    });
    await seedImportedTransaction(user.id, a.id, {
      amount: m(10000),
      bookingDate: "2026-03-10",
    });
    const taken = await seedImportedTransaction(user.id, b.id, {
      amount: m(10000),
      bookingDate: "2026-03-10",
    });
    const partner = await seedImportedTransaction(user.id, a.id, {
      amount: m(-1),
      bookingDate: "2026-03-10",
    });
    await linkManually(user.id, partner.id, taken.id);

    const list = await transferCandidates(user.id, out.id);
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
    await send();
    await linkTransfers(user.id, {});
    expect(
      await transferCandidates(user.id, (await rowsOf(b.id))[0]!.id),
    ).toEqual([]);
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
    await ctx.send({ reference: "RF-1" });
    await linkTransfers(ctx.user.id, {});
    const mirror = (await rowsOf(ctx.b.id))[0]!;
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
    const find = async (over = {}) =>
      (await findReplacements(user.id, b.id, [incoming(over)])).get("r");
    expect(await find()).toBeUndefined();
    expect(await find({ description: "Cash deposit" })).toBeUndefined();
    expect(await find({ reference: "RF-1" })).toBe(mirror.id);
    expect(await find({ description: "Savings top-up" })).toBe(mirror.id);
  });

  it("leaves the mirror, flagged inside an imported period, when nothing ties the row to it", async () => {
    const { user, b, mirror } = await mirrored();
    await seedImport(user.id, b.id, {
      statementFrom: "2026-03-01",
      statementTo: "2026-03-31",
    });
    expect(
      (
        await findReplacements(user.id, b.id, [
          incoming({ description: "Cash" }),
        ])
      ).size,
    ).toBe(0);
    expect((await getTransaction(user.id, mirror.id)).mirrorOf).toMatchObject({
      noBankCounterpart: true,
    });
  });

  it("is replaced by a manual row that matches, which keeps the link", async () => {
    const { user, a, b, mirror } = await mirrored();
    const out = (await rowsOf(a.id))[0]!;
    const view = await createManualTransaction(user.id, b.id, manualInput());
    expect((await rowsOf(b.id)).map((r) => r.id)).toEqual([view.id]);
    expect((await rowsOf(b.id))[0]!.id).not.toBe(mirror.id);
    expect(await allTransfers()).toEqual([
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
    await createManualTransaction(
      user.id,
      b.id,
      manualInput({ amount: m(9999) }),
    );
    await createManualTransaction(
      user.id,
      b.id,
      manualInput({ counterpartyIban: EXAMPLE_IBAN_THIRD }),
    );
    expect((await rowsOf(b.id)).some((r) => r.id === mirror.id)).toBe(true);
    expect(await rowsOf(b.id)).toHaveLength(3);
  });

  it("takes over nothing from another user", async () => {
    const { user, b } = await mirrored();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, { iban: FOREIGN_IBANS[0]! });
    await createManualTransaction(
      other.id,
      theirs.id,
      manualInput({ counterpartyIban: null }),
    );
    expect(await rowsOf(b.id)).toHaveLength(1);
    expect((await rowsOf(b.id))[0]!.source).toBe("mirror");
    expect(user.id).not.toBe(other.id);
  });
});

describe("dismissed transfers", () => {
  it("count again in the month summary and the review once unlinked", async () => {
    const { user, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    expect((await monthSummary(user.id, { month: "2026-03" })).totals).toEqual(
      [],
    );
    await unlink(user.id, (await allTransfers())[0]!.id);
    expect((await monthSummary(user.id, { month: "2026-03" })).totals).toEqual([
      { currency: "CHF", income: 0, expenses: 10000, net: -10000 },
    ]);
    const review = await yearReview(user.id, {
      year: 2026,
      today: "2026-12-31",
    });
    expect(review.excludedTransfers).toBe(0);
    expect(review.currencies).toHaveLength(1);
  });

  it("only turn the heuristic off for the rows they name", async () => {
    const { user, send } = await setup();
    await send();
    await send({ bookingDate: "2026-03-20", amount: m(-500) });
    await linkTransfers(user.id, {});
    const first = (await allTransfers()).find(
      (t) => t.outTransactionId !== null,
    )!;
    await unlink(user.id, first.id);
    const totals = (await monthSummary(user.id, { month: "2026-03" })).totals;
    expect(totals).toHaveLength(1);
    expect(totals[0]!.expenses).toBeGreaterThan(0);
    expect(totals[0]!.expenses).toBeLessThan(10500);
  });
});

describe("keeping links valid", () => {
  const manualDebit = async (userId: string, accountId: string, over = {}) =>
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
  const edit = (
    view: Awaited<ReturnType<typeof getTransaction>>,
    over = {},
  ) => ({
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
    const real = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-11",
      amount: m(10000),
    });
    const out = await manualDebit(user.id, a.id);
    expect(await allTransfers()).toEqual([
      expect.objectContaining({ method: "paired", status: "linked" }),
    ]);
    // A text change keeps it.
    await updateTransaction(
      user.id,
      out.id,
      edit(out, { description: "Rent" }),
    );
    expect(await allTransfers()).toHaveLength(1);
    // Another amount breaks it; both rows stay.
    await updateTransaction(user.id, out.id, edit(out, { amount: m(-9000) }));
    expect(await allTransfers()).toEqual([]);
    expect((await getTransaction(user.id, real.id)).transfer).toBeNull();
    expect((await getTransaction(user.id, out.id)).transfer).toBeNull();
    // Changing it back links the pair again.
    await updateTransaction(user.id, out.id, edit(out));
    expect(await allTransfers()).toHaveLength(1);
  });

  it("moves a pair to the account the edited IBAN now names", async () => {
    const { user, a, b } = await setup({ fill: false });
    const c = await seedAccount(user.id, {
      name: "Third",
      iban: EXAMPLE_IBAN_THIRD,
    });
    const realB = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-11",
      amount: m(10000),
    });
    const realC = await seedImportedTransaction(user.id, c.id, {
      bookingDate: "2026-03-12",
      amount: m(10000),
    });
    const out = await manualDebit(user.id, a.id);
    expect((await allTransfers()).map((t) => t.inTransactionId)).toEqual([
      realB.id,
    ]);
    await updateTransaction(
      user.id,
      out.id,
      edit(out, { counterpartyIban: EXAMPLE_IBAN_THIRD }),
    );
    expect((await getTransaction(user.id, realB.id)).transfer).toBeNull();
    expect((await allTransfers()).map((t) => t.inTransactionId)).toEqual([
      realC.id,
    ]);
  });

  it("keeps a manual link through a text edit and drops it when the signs stop being opposite", async () => {
    const { user, a, b } = await setup({ fill: false });
    const out = await manualDebit(user.id, a.id, { counterpartyIban: null });
    const into = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-30",
      amount: m(4000),
    });
    await linkManually(user.id, out.id, into.id);
    await updateTransaction(user.id, out.id, edit(out, { description: "x" }));
    expect(await allTransfers()).toEqual([
      expect.objectContaining({ method: "manual", status: "linked" }),
    ]);
    await updateTransaction(user.id, out.id, edit(out, { amount: m(500) }));
    expect(await allTransfers()).toEqual([]);
  });

  it("drops mirrors and pairs when the receiving account's IBAN changes", async () => {
    const { user, a, b, send } = await setup();
    await send();
    await send({ bookingDate: "2026-03-20", amount: m(-700) });
    await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-21",
      amount: m(700),
    });
    await linkTransfers(user.id, {});
    expect(await allTransfers()).toHaveLength(2);
    const view = await getAccount(user.id, b.id);
    await updateAccount(user.id, b.id, {
      ...inputOf(view),
      iban: EXAMPLE_IBAN_THIRD,
    });
    expect(await allTransfers()).toEqual([]);
    expect((await rowsOf(b.id)).every((r) => r.source !== "mirror")).toBe(true);
    // Rows naming the new IBAN link from now on.
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-04-01",
      amount: m(-100),
      counterpartyIban: EXAMPLE_IBAN_THIRD,
    });
    await updateAccount(user.id, b.id, {
      ...inputOf(await getAccount(user.id, b.id)),
    });
    expect((await linkTransfers(user.id, {})).mirrored).toBe(1);
  });

  it("keeps links when an account is saved without a new IBAN", async () => {
    const { user, b, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    await updateAccount(user.id, b.id, {
      ...inputOf(await getAccount(user.id, b.id)),
      name: "Renamed",
    });
    expect(await allTransfers()).toHaveLength(1);
  });

  it("deletes a mirror that has no transfer", async () => {
    const { user, b } = await setup();
    const orphan = await seedImportedTransaction(user.id, b.id, {
      source: "mirror",
      externalId: "mirror:orphan",
      amount: m(100),
    });
    await deleteTransaction(user.id, orphan.id);
    expect(await rowsOf(b.id)).toEqual([]);
  });

  describe("foreign currency mirrors", () => {
    async function fxManual() {
      const user = await createTestUser();
      const a = await seedAccount(user.id, {
        name: "Main",
        iban: EXAMPLE_IBAN,
      });
      const eur = await seedAccount(user.id, {
        name: "Euro",
        currency: "EUR",
        iban: EXAMPLE_IBAN_OTHER,
        fillFromTransfers: true,
      });
      const out = await manualDebit(user.id, a.id);
      const [pending] = await listNeedsAmount(user.id);
      await resolveNeedsAmount(user.id, pending!.transferId, m(9300));
      return { user, a, eur, out };
    }

    it("keeps a hand-resolved mirror, its amount, note and category, through an edit of the source", async () => {
      const { user, eur, out } = await fxManual();
      const mirror = (await rowsOf(eur.id))[0]!;
      const category = await createCategory(user.id, {
        name: "Savings",
        kind: "expense",
        parentId: null,
        color: null,
        icon: null,
      });
      await getDB()
        .update(transactions)
        .set({ note: "kept", categoryId: category.id })
        .where(eq(transactions.id, mirror.id));
      await updateTransaction(
        user.id,
        out.id,
        edit(out, { description: "Rent", bookingDate: "2026-03-11" }),
      );
      expect(await rowsOf(eur.id)).toEqual([
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
      expect(await allTransfers()).toEqual([
        expect.objectContaining({ status: "linked", method: "mirrored" }),
      ]);
      expect(await listNeedsAmount(user.id)).toEqual([]);
    });

    it("drops the mirror and asks again when the sign of the source flips", async () => {
      const { user, eur, out } = await fxManual();
      await updateTransaction(user.id, out.id, edit(out, { amount: m(10000) }));
      expect(await rowsOf(eur.id)).toEqual([]);
      expect(await listNeedsAmount(user.id)).toHaveLength(1);
    });

    it("swaps the sides of a same-currency mirrored transfer when the source flips sign", async () => {
      const user = await createTestUser();
      const a = await seedAccount(user.id, {
        name: "Main",
        iban: EXAMPLE_IBAN,
      });
      const b = await seedAccount(user.id, {
        name: "Savings",
        type: "savings",
        iban: EXAMPLE_IBAN_OTHER,
        fillFromTransfers: true,
      });
      const out = await manualDebit(user.id, a.id);
      const mirror = (await rowsOf(b.id))[0]!;
      await getDB()
        .update(transactions)
        .set({ note: "kept" })
        .where(eq(transactions.id, mirror.id));
      await updateTransaction(user.id, out.id, edit(out, { amount: m(10000) }));
      const [t] = await allTransfers();
      expect(t).toMatchObject({
        status: "linked",
        method: "mirrored",
        outTransactionId: mirror.id,
        inTransactionId: out.id,
        fromAccountId: b.id,
        toAccountId: a.id,
      });
      expect(await rowsOf(b.id)).toEqual([
        expect.objectContaining({
          id: mirror.id,
          amount: -10000,
          note: "kept",
        }),
      ]);

      await updateTransaction(
        user.id,
        out.id,
        edit(out, { amount: m(-10000) }),
      );
      expect(await allTransfers()).toEqual([
        expect.objectContaining({
          status: "linked",
          outTransactionId: out.id,
          inTransactionId: mirror.id,
          fromAccountId: a.id,
          toAccountId: b.id,
        }),
      ]);

      await updateTransaction(user.id, out.id, edit(out, { amount: m(10000) }));
      const [flipped] = await allTransfers();
      await unlink(user.id, flipped!.id);
      expect(await rowsOf(b.id)).toEqual([]);
      expect(await allTransfers()).toEqual([
        expect.objectContaining({
          status: "dismissed",
          outTransactionId: null,
          inTransactionId: out.id,
          fromAccountId: b.id,
          toAccountId: a.id,
        }),
      ]);
    });

    it("keeps the link of a taken-over mirror through revalidateLinks and a resync", async () => {
      const { user, a, eur, out } = await fxManual();
      const real = await createManualTransaction(
        user.id,
        eur.id,
        manualInput({
          amount: m(9300),
          counterpartyIban: EXAMPLE_IBAN,
          bookingDate: "2026-03-11",
        }),
      );
      expect((await rowsOf(eur.id)).map((r) => r.id)).toEqual([real.id]);
      expect(await allTransfers()).toEqual([
        expect.objectContaining({ method: "paired", status: "linked" }),
      ]);
      expect(
        await transaction(async (tx) => revalidateLinks(tx, user.id, eur.id)),
      ).toBe(0);
      expect(
        await transaction(async (tx) => revalidateLinks(tx, user.id, a.id)),
      ).toBe(0);
      await updateTransaction(user.id, out.id, edit(out, { description: "x" }));
      expect(await allTransfers()).toEqual([
        expect.objectContaining({ method: "paired", status: "linked" }),
      ]);
      expect(await linkTransfers(user.id, {})).toMatchObject({
        mirrored: 0,
        needsAmount: 0,
      });
      expect(await rowsOf(eur.id)).toHaveLength(1);
    });
  });

  describe("dismissed transfers and edits", () => {
    it("keeps a dismissed pair when only the IBAN changes", async () => {
      const { user, a, b } = await setup({ fill: false });
      const real = await seedImportedTransaction(user.id, b.id, {
        bookingDate: "2026-03-11",
        amount: m(10000),
      });
      const out = await manualDebit(user.id, a.id);
      await unlink(user.id, (await allTransfers())[0]!.id);
      expect(await allTransfers()).toEqual([
        expect.objectContaining({
          status: "dismissed",
          outTransactionId: out.id,
          inTransactionId: real.id,
        }),
      ]);
      const none = await updateTransaction(
        user.id,
        out.id,
        edit(out, { counterpartyIban: null }),
      );
      await updateTransaction(
        user.id,
        out.id,
        edit(none, { counterpartyIban: EXAMPLE_IBAN_OTHER }),
      );
      expect(await allTransfers()).toEqual([
        expect.objectContaining({ status: "dismissed" }),
      ]);
      expect((await getTransaction(user.id, real.id)).transfer).toBeNull();
    });

    it("forgets a dismissed mirror only when the IBAN names another own account", async () => {
      const { user, a, b } = await setup();
      const c = await seedAccount(user.id, {
        name: "Third",
        iban: EXAMPLE_IBAN_THIRD,
        fillFromTransfers: true,
      });
      const out = await manualDebit(user.id, a.id);
      await unlink(user.id, (await allTransfers())[0]!.id);
      expect(await rowsOf(b.id)).toEqual([]);
      // A text edit or an IBAN that names nobody keeps the dismissal.
      const same = await updateTransaction(
        user.id,
        out.id,
        edit(out, { description: "x" }),
      );
      expect(await rowsOf(b.id)).toEqual([]);
      const none = await updateTransaction(
        user.id,
        out.id,
        edit(same, { counterpartyIban: null }),
      );
      expect(await allTransfers()).toEqual([
        expect.objectContaining({ status: "dismissed" }),
      ]);
      await updateTransaction(
        user.id,
        out.id,
        edit(none, { counterpartyIban: EXAMPLE_IBAN_OTHER }),
      );
      expect(await rowsOf(b.id)).toEqual([]);
      // Another own account is a new question.
      await updateTransaction(
        user.id,
        out.id,
        edit(none, { counterpartyIban: EXAMPLE_IBAN_THIRD }),
      );
      expect(await rowsOf(c.id)).toHaveLength(1);
      expect(
        (await allTransfers()).filter((t) => t.status === "dismissed"),
      ).toEqual([]);
    });
  });
});

describe("listing needs-amount rows", () => {
  it("lists every pending transfer, newest first, filtered by account, across users", async () => {
    const user = await createTestUser();
    const a = await seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
    const eur = await seedAccount(user.id, {
      name: "Euro",
      currency: "EUR",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const usd = await seedAccount(user.id, {
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
      await seedImportedTransaction(user.id, a.id, {
        bookingDate: date,
        amount: m(amount),
        counterpartyIban: iban,
      });
    }
    await linkTransfers(user.id, {});
    expect((await listNeedsAmount(user.id)).map((r) => r.bookingDate)).toEqual([
      "2026-03-12",
      "2026-03-11",
      "2026-03-10",
    ]);
    expect(await listNeedsAmount(user.id, eur.id)).toHaveLength(2);
    expect(await listNeedsAmount(user.id, usd.id)).toHaveLength(1);
    const other = await createTestUser();
    expect(await listNeedsAmount(other.id)).toEqual([]);
  });
});

describe("another user's data", () => {
  it("is invisible to every transfer function", async () => {
    const { user, b, send } = await setup();
    const out = await send();
    await linkTransfers(user.id, {});
    const row = (await allTransfers())[0]!;
    const mirror = (await rowsOf(b.id))[0]!;
    const intruder = await createTestUser();
    const own = await seedAccount(intruder.id, { name: "Own" });
    const mine = await seedImportedTransaction(intruder.id, own.id, {
      amount: m(10000),
    });

    const notFound = /not found/i;
    await expect(unlink(intruder.id, row.id)).rejects.toThrow(notFound);
    await expect(resolveNeedsAmount(intruder.id, row.id, m(1))).rejects.toThrow(
      notFound,
    );
    await expect(linkManually(intruder.id, out.id, mine.id)).rejects.toThrow(
      notFound,
    );
    await expect(linkManually(intruder.id, mine.id, mirror.id)).rejects.toThrow(
      notFound,
    );
    await expect(transferCandidates(intruder.id, out.id)).rejects.toThrow(
      notFound,
    );
    await expect(fillSuggestion(intruder.id, b.id)).rejects.toThrow(notFound);
    await expect(enableFill(intruder.id, b.id)).rejects.toThrow(notFound);
    expect(await listNeedsAmount(intruder.id)).toEqual([]);
    expect(await countMirrors(intruder.id, b.id)).toBe(0);
    await expect(getTransaction(intruder.id, mirror.id)).rejects.toThrow(
      notFound,
    );
    expect(await allTransfers()).toHaveLength(1);
  });
});

describe("transaction views", () => {
  it("describe mirrors and transfers", async () => {
    const { user, a, b, send } = await setup();
    const out = await send();
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;

    const view = await getTransaction(user.id, mirror.id);
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
    const source = await getTransaction(user.id, out.id);
    expect(source.mirrorOf).toBeNull();
    expect(source.transfer).toMatchObject({
      direction: "out",
      peerAccountId: b.id,
      peerTransactionId: mirror.id,
    });
    const page = await listTransactions(user.id, b.id);
    expect(page.items[0]).toMatchObject({
      id: mirror.id,
      mirrorOf: { transactionId: out.id },
    });
  });

  it("flags a mirror inside an imported statement period", async () => {
    const { user, b, send } = await setup();
    await send();
    await send({ bookingDate: "2026-05-02" });
    await linkTransfers(user.id, {});
    await seedImport(user.id, b.id, {
      statementFrom: "2026-03-01",
      statementTo: "2026-03-31",
    });
    const flags: Record<string, boolean> = {};
    for (const r of await rowsOf(b.id)) {
      flags[r.bookingDate] = (
        await getTransaction(user.id, r.id)
      ).mirrorOf!.noBankCounterpart;
    }
    expect(flags).toEqual({ "2026-03-10": true, "2026-05-02": false });
  });

  it("make mirrors read-only except for the note and the category", async () => {
    const { user, b, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    const view = await updateTransaction(user.id, mirror.id, { note: "check" });
    expect(view).toMatchObject({ note: "check", amount: 10000 });
    await expect(
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
    ).resolves.not.toThrow();
    expect(await getTransaction(user.id, mirror.id)).toMatchObject({
      bookingDate: "2026-03-10",
      amount: 10000,
    });
  });
});

describe("consumers", () => {
  it("leave linked transfers out of the month summary, with the IBAN fallback for the rest", async () => {
    const { user, b, send } = await setup();
    await send({ counterpartyIban: null });
    const noIbanIn = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-10",
      amount: m(10000),
    });
    await send({ bookingDate: "2026-03-12", amount: m(-300) });
    await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-20",
      amount: m(-40),
      counterpartyIban: EXAMPLE_IBAN_THIRD,
    });
    const before = (await monthSummary(user.id, { month: "2026-03" })).totals;
    expect(before).toEqual([
      { currency: "CHF", income: 10000, expenses: 10040, net: -40 },
    ]);

    const firstRow = (await first(
      getDB()
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.bookingDate, "2026-03-10"),
            eq(transactions.amount, m(-10000)),
          ),
        )
        .limit(1),
    ))!;
    await linkManually(user.id, firstRow.id, noIbanIn.id);
    // The other row names an own IBAN: the heuristic still excludes it.
    expect((await monthSummary(user.id, { month: "2026-03" })).totals).toEqual([
      { currency: "CHF", income: 0, expenses: 40, net: -40 },
    ]);
  });

  it("do not count a mirror or its source in the month summary or the review", async () => {
    const { user, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    expect((await monthSummary(user.id, { month: "2026-03" })).totals).toEqual(
      [],
    );
    const review = await yearReview(user.id, {
      year: 2026,
      today: "2026-12-31",
    });
    expect(review.currencies).toEqual([]);
    expect(review.excludedTransfers).toBeGreaterThanOrEqual(1);
  });

  it("exclude linked pairs without IBANs from the month summary and the review", async () => {
    const user = await createTestUser();
    const a = await seedAccount(user.id, { name: "A" });
    const b = await seedAccount(user.id, { name: "B" });
    const out = await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(-2000),
    });
    const into = await seedImportedTransaction(user.id, b.id, {
      bookingDate: "2026-03-10",
      amount: m(2000),
    });
    expect(
      (await monthSummary(user.id, { month: "2026-03" })).totals[0],
    ).toMatchObject({
      income: 2000,
      expenses: 2000,
    });
    await linkManually(user.id, out.id, into.id);
    expect((await monthSummary(user.id, { month: "2026-03" })).totals).toEqual(
      [],
    );
    const review = await yearReview(user.id, {
      year: 2026,
      today: "2026-12-31",
    });
    expect(review.excludedTransfers).toBe(2);
    expect(review.currencies).toEqual([]);
  });

  it("leave linked transfers out of budgets and spending", async () => {
    const { user, a, b, send } = await setup();
    const food = await createCategory(user.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await send({ categoryId: food.id });
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-11",
      amount: m(-700),
      categoryId: food.id,
    });
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-12",
      amount: m(-50),
    });
    expect(
      (await spendingByCategory(user.id, "2026-03")).currencies[0]!.total,
    ).toBe(10700);
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    await getDB()
      .update(transactions)
      .set({ categoryId: food.id })
      .where(eq(transactions.id, mirror.id));
    const spending = await spendingByCategory(user.id, "2026-03");
    expect(spending.currencies[0]!.total).toBe(700);
    expect(spending.uncategorizedCount).toBe(1);
  });

  it("never categorize mirrors by rule", async () => {
    const { user, b, send } = await setup();
    const cat = await createCategory(user.id, {
      name: "Moves",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await createRule(user.id, {
      categoryId: cat.id,
      priority: 0,
      counterpartyContains: null,
      descriptionContains: "savings",
      counterpartyIban: null,
      amountSign: null,
    });
    const out = await send();
    await linkTransfers(user.id, {});
    expect(await applyRulesToUncategorized(user.id)).toMatchObject({
      categorized: 1,
    });
    expect((await getTransaction(user.id, out.id)).categoryId).toBe(cat.id);
    expect(
      (await getTransaction(user.id, (await rowsOf(b.id))[0]!.id)).categoryId,
    ).toBeNull();
  });

  it("skip mirrors when detecting recurring payments", async () => {
    const { user, b, send } = await setup();
    for (const month of ["01", "02", "03"]) {
      await send({
        bookingDate: `2026-${month}-05`,
        amount: m(-5000),
        counterpartyName: "Savings plan",
      });
    }
    await linkTransfers(user.id, {});
    expect(await rowsOf(b.id)).toHaveLength(3);
    await syncRecurring(user.id);
    const series = await listRecurring(user.id, "2026-04-01");
    expect(series).toHaveLength(1);
    expect(series[0]!.lastAmount).toBe(-5000);
  });

  it("keep mirrors out of bill matching", async () => {
    const { user, a, b } = await setup();
    const reference = makeQrr(42);
    const bill = await seedBill(user.id, {
      amount: m(10000),
      reference,
      referenceType: "QRR",
      creditorIban: EXAMPLE_IBAN_THIRD,
    });
    // An outgoing transfer carrying a bill's reference: its mirror is a credit, never a payment.
    await seedImportedTransaction(user.id, a.id, {
      bookingDate: "2026-03-10",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
      reference,
      referenceType: "QRR",
    });
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    expect(mirror.amount).toBe(-10000);
    expect(
      (await getSuggestions(user.id, { billId: bill.id })).map(
        (s) => s.transactionId,
      ),
    ).not.toContain(mirror.id);
    expect(
      (await candidateTransactions(user.id, bill.id)).items.map((c) => c.id),
    ).not.toContain(mirror.id);
    await expect(
      allocate(user.id, bill.id, mirror.id, m(10000), "user"),
    ).rejects.toThrow(/mirrored transfer/);
    expect(
      (await unmatchedTransactions(user.id, { today: "2026-03-20" })).count,
    ).toBe(0);
  });

  it("keep mirrors out of tax suggestions, tagging and deductions", async () => {
    const { user, b, send } = await setup();
    await send({
      bookingDate: "2025-03-09",
      amount: m(10000),
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    expect(mirror.amount).toBe(-10000);

    await upsertTaxYear(
      user.id,
      taxYearInputSchema.parse({
        year: "2025",
        authority: "Example Tax Office",
        currency: "CHF",
        assessedTotal: "",
        notes: "",
      }),
    );
    await addTaxCredit(
      user.id,
      2025,
      taxCreditInputSchema("CHF").parse({
        bookingDate: "2025-03-11",
        amount: "100.00",
        reference: "",
        description: "",
      }),
    );
    const rec = (await reconcileYear(user.id, 2025))!;
    expect(rec.suggestions.map((s) => s.transactionId)).not.toContain(
      mirror.id,
    );

    const cat = await createCategory(user.id, {
      name: "Gifts",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await setCategoryDeduction(user.id, cat.id, "donations");
    await getDB()
      .update(transactions)
      .set({ categoryId: cat.id })
      .where(eq(transactions.id, mirror.id));
    expect((await deductionSummary(user.id, 2025)).totals).toEqual([]);

    await expect(
      setTransactionTaxYear(user.id, mirror.id, 2025),
    ).rejects.toThrow(/mirrored transfer/);
    await expect(
      setTransactionDeductionYear(user.id, mirror.id, 2025),
    ).rejects.toThrow(/mirrored transfer/);
    await expect(
      setTransactionDeductionExcluded(user.id, mirror.id, true),
    ).rejects.toThrow(/mirrored transfer/);
  });

  it("keep mirrors out of pillar 3a contribution detection", async () => {
    const { user, b, send } = await setup();
    const p3a = await seedPillar3aAccount(user.id);
    const reference = makeQrr(7);
    await seedPortfolio(user.id, p3a.id, { depositReference: reference });
    await send({
      amount: m(10000),
      reference,
      referenceType: "QRR",
      counterpartyIban: EXAMPLE_IBAN_OTHER,
    });
    await linkTransfers(user.id, {});
    const mirror = (await rowsOf(b.id))[0]!;
    expect(mirror.reference).toBe(reference);
    expect(await detectedContributions(user.id)).toEqual([]);
  });
});

describe("the in-transaction variants", () => {
  it("loadPlanAccountsInTx matches loadPlanAccounts and only sees the user's accounts", async () => {
    const { user, a, b } = await setup();
    const other = await createTestUser();
    await seedAccount(other.id, { name: "Theirs", iban: EXAMPLE_IBAN_THIRD });
    const inTx = await transaction(async (tx) =>
      loadPlanAccountsInTx(tx, user.id),
    );
    expect(inTx).toEqual(await loadPlanAccounts(user.id));
    expect(inTx.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(
      await transaction(async (tx) => loadPlanAccountsInTx(tx, other.id)),
    ).toHaveLength(1);
  });

  it("countMirrorsInTx matches countMirrors, per user", async () => {
    const { user, b, send } = await setup();
    await send();
    await linkTransfers(user.id, {});
    const other = await createTestUser();
    expect(await countMirrors(user.id, b.id)).toBe(1);
    expect(
      await transaction(async (tx) => countMirrorsInTx(tx, user.id, b.id)),
    ).toBe(1);
    expect(
      await transaction(async (tx) => countMirrorsInTx(tx, other.id, b.id)),
    ).toBe(0);
  });

  it("findReplacementsInTx matches findReplacements and ignores other users' mirrors", async () => {
    const { user, b, send } = await setup();
    await send({ reference: "RF-1" });
    await linkTransfers(user.id, {});
    const rows = [
      {
        key: "r",
        bookingDate: "2026-03-11",
        amount: 10000,
        counterpartyIban: null,
        reference: "RF-1",
        description: null,
      },
    ];
    const viaDb = await findReplacements(user.id, b.id, rows);
    expect(viaDb.size).toBe(1);
    expect(
      await transaction(async (tx) =>
        findReplacementsInTx(tx, user.id, b.id, rows),
      ),
    ).toEqual(viaDb);
    const other = await createTestUser();
    expect(
      (
        await transaction(async (tx) =>
          findReplacementsInTx(tx, other.id, b.id, rows),
        )
      ).size,
    ).toBe(0);
  });

  it("linkTransfersInTx joins the caller's transaction, linkTransfers opens its own", async () => {
    const { user, send } = await setup();
    await send();
    await expect(
      transaction(async (tx) => {
        await linkTransfersInTx(tx, user.id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await allTransfers()).toEqual([]);
    expect(await linkTransfers(user.id)).toMatchObject({ mirrored: 1 });
    expect(await allTransfers()).toHaveLength(1);
  });
});
