import { error, fail, redirect } from "@sveltejs/kit";
import { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import {
  assignCategory,
  assignCategorySchema,
  listCategories,
} from "$lib/server/categories";
import { parseForm, safeValues } from "$lib/server/forms";
import {
  createTrade,
  deleteTrade,
  getTrade,
  listSecurities,
  listTrades,
  tradeInputSchema,
  updateTrade,
} from "$lib/server/investments";
import { accountValue, localToday } from "$lib/server/ledger";
import {
  archiveAccount,
  deleteAccount,
  getAccount,
  unarchiveAccount,
  updateAccount,
} from "$lib/server/ledger/accounts";
import { ledgerFailure, orNotFoundAsync } from "$lib/server/ledger/http";
import { listInstitutions } from "$lib/server/ledger/institutions";
import {
  accountInputSchema,
  amountField,
  idFormSchema,
  parseListQuery,
  snapshotInputSchema,
  transactionInputSchema,
  transactionNoteSchema,
} from "$lib/server/ledger/schemas";
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
} from "$lib/server/ledger/snapshots";
import {
  createManualTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "$lib/server/ledger/transactions";
import {
  closePortfolio,
  createPortfolio,
  deletePortfolio,
  deleteValue,
  getPortfolio,
  listPortfolios,
  listValues,
  parsePortfolioValuesForm,
  portfolioCloseSchema,
  portfolioInputSchema,
  reopenPortfolio,
  setValues,
  updatePortfolio,
  type PortfolioValueView,
} from "$lib/server/pillar3a";
import { getPreferences } from "$lib/server/preferences";
import {
  countMirrors,
  enableFill,
  fillSuggestion,
  linkManually,
  linkNeedsAmountTo,
  listNeedsAmount,
  resolveNeedsAmount,
  transferCandidates,
  unlink,
} from "$lib/server/transfers";
import { deductionYearTagSchema, taxTagSchema } from "$lib/server/tax/schemas";
import { setTransactionDeductionYear } from "$lib/server/tax/deductions";
import { setTransactionTaxYear } from "$lib/server/tax/tax";
import type { Actions, PageServerLoad } from "./$types";

const accountFields = [
  "institutionId",
  "name",
  "type",
  "currency",
  "iban",
  "contractNumber",
  "depositIban",
  "openingBalance",
  "openingDate",
  "noticeMonths",
  "freeWithdrawal",
  "freeWithdrawalPeriod",
  "share",
  "sharedWith",
  "sortOrder",
  "fillFromTransfers",
  "tradesMoveCash",
] as const;
const transactionFields = [
  "bookingDate",
  "valueDate",
  "amount",
  "counterpartyName",
  "counterpartyIban",
  "description",
  "reference",
  "note",
] as const;
const snapshotFields = ["date", "amount", "note"] as const;
const portfolioFields = [
  "name",
  "number",
  "strategy",
  "depositReference",
  "openedOn",
  "sortOrder",
] as const;
const tradeFields = [
  "securityId",
  "date",
  "side",
  "quantity",
  "splitNew",
  "splitOld",
  "price",
  "fees",
  "amount",
  "note",
] as const;

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const user = requireUser(locals);
  const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
  const query = parseListQuery(
    url.searchParams,
    account.currency,
    (await getPreferences(user.id)).pageSize,
  );
  const trades = await listTrades(user.id, account.id);
  const portfolios = await listPortfolios(user.id, account.id);
  const hasHoldings = account.type === "investment" || trades.length > 0;
  const showPortfolios = account.type === "pillar_3a" || portfolios.length > 0;
  const portfolioValues: Record<string, PortfolioValueView[]> = {};
  for (const p of portfolios) {
    portfolioValues[p.id] = await listValues(user.id, p.id);
  }
  return {
    account,
    balance: account.balance,
    // Cash, holdings and portfolios are only broken out where they are in play.
    value:
      hasHoldings || showPortfolios
        ? await accountValue(user.id, account.id, localToday())
        : null,
    hasHoldings,
    showPortfolios,
    portfolios,
    portfolioValues,
    trades,
    securities: await listSecurities(user.id),
    institutions: (await listInstitutions(user.id)).map((i) => ({
      id: i.id,
      name: i.name,
    })),
    transactions: await listTransactions(user.id, account.id, {
      filters: query.filters,
      page: query.page,
      pageSize: query.pageSize,
    }),
    snapshots: await listSnapshots(user.id, account.id),
    transfers: {
      /** Mirrored transactions on this account (for the confirm dialog when filling is turned off). */
      mirrorCount: await countMirrors(user.id, account.id),
      /** Never-imported account that is not filled yet: transfers other accounts show to its IBAN. */
      fillSuggestion: await fillSuggestion(user.id, account.id),
      /** FX transfers waiting for the amount this account received or paid. */
      needsAmount: await listNeedsAmount(user.id, account.id),
    },
    categories: await listCategories(user.id),
    filters: query.raw,
    filterErrors: query.errors,
  };
};

async function ownedTransaction(userId: string, accountId: string, id: string) {
  const tx = await orNotFoundAsync(() => getTransaction(userId, id));
  if (tx.accountId !== accountId) error(404, "Transaction not found.");
  return tx;
}

async function ownedTrade(userId: string, accountId: string, id: string) {
  const trade = await orNotFoundAsync(() => getTrade(userId, id));
  if (trade.accountId !== accountId) error(404, "Trade not found.");
  return trade;
}

async function ownedPortfolio(userId: string, accountId: string, id: string) {
  const portfolio = await orNotFoundAsync(() => getPortfolio(userId, id));
  if (portfolio.accountId !== accountId) error(404, "Portfolio not found.");
  return portfolio;
}

export const actions: Actions = {
  updateAccount: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, accountFields);
    const parsed = parseForm(accountInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "updateAccount",
        errors: parsed.errors,
        values,
      });
    }
    try {
      await updateAccount(user.id, params.id, parsed.data);
      return { success: true as const, action: "updateAccount" as const };
    } catch (err) {
      return ledgerFailure("updateAccount", err, values);
    }
  },

  archive: async ({ locals, params }) => {
    const user = requireUser(locals);
    await orNotFoundAsync(() => archiveAccount(user.id, params.id));
    return { success: true as const, action: "archive" as const };
  },

  unarchive: async ({ locals, params }) => {
    const user = requireUser(locals);
    await orNotFoundAsync(() => unarchiveAccount(user.id, params.id));
    return { success: true as const, action: "unarchive" as const };
  },

  deleteAccount: async ({ locals, params }) => {
    const user = requireUser(locals);
    await orNotFoundAsync(() => deleteAccount(user.id, params.id));
    redirect(303, "/accounts");
  },

  addTransaction: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, transactionFields);
    const parsed = parseForm(transactionInputSchema(account.currency), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "addTransaction",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const created = await createManualTransaction(
        user.id,
        account.id,
        parsed.data,
      );
      return {
        success: true as const,
        action: "addTransaction" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("addTransaction", err, values);
    }
  },

  updateTransaction: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId", ...transactionFields]);
    const idParsed = parseForm(idFormSchema("transactionId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "updateTransaction",
        errors: idParsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      idParsed.data.transactionId,
    );
    const parsed =
      existing.source !== "manual"
        ? parseForm(transactionNoteSchema, form)
        : parseForm(transactionInputSchema(account.currency), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "updateTransaction",
        errors: parsed.errors,
        values,
      });
    }
    try {
      await updateTransaction(user.id, existing.id, parsed.data);
      return {
        success: true as const,
        action: "updateTransaction" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("updateTransaction", err, values);
    }
  },

  setTaxYear: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId", "taxYear"]);
    const parsed = parseForm(taxTagSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "setTaxYear",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    try {
      await setTransactionTaxYear(user.id, existing.id, parsed.data.taxYear);
      return { success: true as const, action: "setTaxYear" as const };
    } catch (err) {
      return ledgerFailure("setTaxYear", err, values);
    }
  },

  setDeductionYear: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId", "deductionYear"]);
    const parsed = parseForm(deductionYearTagSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "setDeductionYear",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    try {
      await setTransactionDeductionYear(
        user.id,
        existing.id,
        parsed.data.deductionYear,
      );
      return {
        success: true as const,
        action: "setDeductionYear" as const,
      };
    } catch (err) {
      return ledgerFailure("setDeductionYear", err, values);
    }
  },

  deleteTransaction: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(idFormSchema("transactionId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteTransaction",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    try {
      await deleteTransaction(user.id, existing.id);
      return {
        success: true as const,
        action: "deleteTransaction" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("deleteTransaction", err, values);
    }
  },

  unlinkTransfer: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(idFormSchema("transactionId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "unlinkTransfer",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    if (!existing.transfer) error(404, "Transfer not found.");
    try {
      await unlink(user.id, existing.transfer.id);
      return {
        success: true as const,
        action: "unlinkTransfer" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("unlinkTransfer", err, values);
    }
  },

  linkTransfer: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId", "peerId"]);
    const parsed = parseForm(
      idFormSchema("transactionId").and(idFormSchema("peerId")),
      form,
    );
    if (!parsed.ok) {
      return fail(400, {
        action: "linkTransfer",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    const peer = await orNotFoundAsync(() =>
      getTransaction(user.id, parsed.data.peerId),
    );
    try {
      const transferId =
        existing.amount < 0
          ? await linkManually(user.id, existing.id, peer.id)
          : await linkManually(user.id, peer.id, existing.id);
      return {
        success: true as const,
        action: "linkTransfer" as const,
        id: existing.id,
        transferId,
      };
    } catch (err) {
      return ledgerFailure("linkTransfer", err, values);
    }
  },

  /** Suggestions for the "Link as transfer" picker: `candidates` in the action result. */
  transferCandidates: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(idFormSchema("transactionId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "transferCandidates",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    return {
      success: true as const,
      action: "transferCandidates" as const,
      transactionId: existing.id,
      candidates: await transferCandidates(user.id, existing.id),
    };
  },

  resolveNeedsAmount: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transferId", "amount"]);
    const idParsed = parseForm(idFormSchema("transferId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "resolveNeedsAmount",
        errors: idParsed.errors,
        values,
      });
    }
    const pending = (await listNeedsAmount(user.id, account.id)).find(
      (n) => n.transferId === idParsed.data.transferId,
    );
    if (!pending) error(404, "Transfer not found.");
    const parsed = parseForm(
      z.object({
        amount: amountField(pending.targetCurrency, { nonZero: true }),
      }),
      form,
    );
    if (!parsed.ok) {
      return fail(400, {
        action: "resolveNeedsAmount",
        errors: parsed.errors,
        values,
      });
    }
    try {
      await resolveNeedsAmount(user.id, pending.transferId, parsed.data.amount);
      return {
        success: true as const,
        action: "resolveNeedsAmount" as const,
        id: pending.transferId,
      };
    } catch (err) {
      return ledgerFailure("resolveNeedsAmount", err, values);
    }
  },

  /** "Link instead": ties the source of a needs-amount transfer to a booked row of this account. */
  linkNeedsAmount: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transferId", "peerId"]);
    const parsed = parseForm(
      idFormSchema("transferId").and(idFormSchema("peerId")),
      form,
    );
    if (!parsed.ok) {
      return fail(400, {
        action: "linkNeedsAmount",
        errors: parsed.errors,
        values,
      });
    }
    const pending = (await listNeedsAmount(user.id, account.id)).find(
      (n) => n.transferId === parsed.data.transferId,
    );
    if (!pending) error(404, "Transfer not found.");
    try {
      await linkNeedsAmountTo(user.id, pending.transferId, parsed.data.peerId);
      return {
        success: true as const,
        action: "linkNeedsAmount" as const,
        id: pending.transferId,
      };
    } catch (err) {
      return ledgerFailure("linkNeedsAmount", err, values);
    }
  },

  /** Turns on "fill from transfers" and creates the mirrors for the account's whole history. */
  enableFillFromTransfers: async ({ locals, params }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    try {
      const result = await enableFill(user.id, account.id);
      return {
        success: true as const,
        action: "enableFillFromTransfers" as const,
        ...result,
      };
    } catch (err) {
      return ledgerFailure("enableFillFromTransfers", err);
    }
  },

  setCategory: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId", "categoryId"]);
    const parsed = parseForm(assignCategorySchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "setCategory",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    try {
      await assignCategory(user.id, existing.id, parsed.data.categoryId);
      return {
        success: true as const,
        action: "setCategory" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("setCategory", err, values);
    }
  },

  addSnapshot: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, snapshotFields);
    const parsed = parseForm(snapshotInputSchema(account.currency), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "addSnapshot",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const created = await createSnapshot(user.id, account.id, parsed.data);
      return {
        success: true as const,
        action: "addSnapshot" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("addSnapshot", err, values);
    }
  },

  deleteSnapshot: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["snapshotId"]);
    const parsed = parseForm(idFormSchema("snapshotId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteSnapshot",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await orNotFoundAsync(() =>
      getSnapshot(user.id, parsed.data.snapshotId),
    );
    if (existing.accountId !== account.id) error(404, "Balance not found.");
    try {
      await deleteSnapshot(user.id, existing.id);
      return {
        success: true as const,
        action: "deleteSnapshot" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("deleteSnapshot", err, values);
    }
  },

  addTrade: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, tradeFields);
    const parsed = parseForm(tradeInputSchema(account.currency), form);
    if (!parsed.ok) {
      return fail(400, { action: "addTrade", errors: parsed.errors, values });
    }
    try {
      const created = await createTrade(user.id, account.id, parsed.data);
      return {
        success: true as const,
        action: "addTrade" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("addTrade", err, values);
    }
  },

  updateTrade: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["tradeId", ...tradeFields]);
    const idParsed = parseForm(idFormSchema("tradeId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "updateTrade",
        errors: idParsed.errors,
        values,
      });
    }
    const existing = await ownedTrade(
      user.id,
      account.id,
      idParsed.data.tradeId,
    );
    const parsed = parseForm(tradeInputSchema(account.currency), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "updateTrade",
        errors: parsed.errors,
        values,
      });
    }
    try {
      await updateTrade(user.id, existing.id, parsed.data);
      return {
        success: true as const,
        action: "updateTrade" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("updateTrade", err, values);
    }
  },

  deleteTrade: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["tradeId"]);
    const parsed = parseForm(idFormSchema("tradeId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteTrade",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedTrade(user.id, account.id, parsed.data.tradeId);
    try {
      await deleteTrade(user.id, existing.id);
      return {
        success: true as const,
        action: "deleteTrade" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("deleteTrade", err, values);
    }
  },

  addPortfolio: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, portfolioFields);
    const parsed = parseForm(portfolioInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "addPortfolio",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const created = await createPortfolio(user.id, account.id, parsed.data);
      return {
        success: true as const,
        action: "addPortfolio" as const,
        id: created.id,
      };
    } catch (err) {
      return ledgerFailure("addPortfolio", err, values);
    }
  },

  updatePortfolio: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["portfolioId", ...portfolioFields]);
    const idParsed = parseForm(idFormSchema("portfolioId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "updatePortfolio",
        errors: idParsed.errors,
        values,
      });
    }
    const existing = await ownedPortfolio(
      user.id,
      account.id,
      idParsed.data.portfolioId,
    );
    const parsed = parseForm(portfolioInputSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "updatePortfolio",
        errors: parsed.errors,
        values,
      });
    }
    try {
      await updatePortfolio(user.id, existing.id, parsed.data);
      return {
        success: true as const,
        action: "updatePortfolio" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("updatePortfolio", err, values);
    }
  },

  closePortfolio: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["portfolioId", "closedOn", "closeReason"]);
    const idParsed = parseForm(idFormSchema("portfolioId"), form);
    if (!idParsed.ok) {
      return fail(400, {
        action: "closePortfolio",
        errors: idParsed.errors,
        values,
      });
    }
    const existing = await ownedPortfolio(
      user.id,
      account.id,
      idParsed.data.portfolioId,
    );
    const parsed = parseForm(portfolioCloseSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "closePortfolio",
        errors: parsed.errors,
        values,
      });
    }
    try {
      await closePortfolio(user.id, existing.id, parsed.data);
      return {
        success: true as const,
        action: "closePortfolio" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("closePortfolio", err, values);
    }
  },

  reopenPortfolio: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["portfolioId"]);
    const parsed = parseForm(idFormSchema("portfolioId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "reopenPortfolio",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedPortfolio(
      user.id,
      account.id,
      parsed.data.portfolioId,
    );
    try {
      await reopenPortfolio(user.id, existing.id);
      return {
        success: true as const,
        action: "reopenPortfolio" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("reopenPortfolio", err, values);
    }
  },

  deletePortfolio: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["portfolioId"]);
    const parsed = parseForm(idFormSchema("portfolioId"), form);
    if (!parsed.ok) {
      return fail(400, {
        action: "deletePortfolio",
        errors: parsed.errors,
        values,
      });
    }
    const existing = await ownedPortfolio(
      user.id,
      account.id,
      parsed.data.portfolioId,
    );
    try {
      await deletePortfolio(user.id, existing.id);
      return {
        success: true as const,
        action: "deletePortfolio" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("deletePortfolio", err, values);
    }
  },

  setPortfolioValues: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") values[key] = value;
    }
    const parsed = parsePortfolioValuesForm(form);
    if (!parsed.ok) {
      return fail(400, {
        action: "setPortfolioValues",
        errors: parsed.errors,
        values,
      });
    }
    // setValues rejects portfolios of another account as not found.
    try {
      await setValues(
        user.id,
        account.id,
        parsed.data.date,
        parsed.data.entries,
        parsed.data.note,
      );
      return {
        success: true as const,
        action: "setPortfolioValues" as const,
      };
    } catch (err) {
      return ledgerFailure("setPortfolioValues", err, values);
    }
  },

  deletePortfolioValue: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = await orNotFoundAsync(() => getAccount(user.id, params.id));
    const form = await request.formData();
    const values = safeValues(form, ["portfolioId", "valueId"]);
    const parsed = parseForm(
      idFormSchema("portfolioId").and(idFormSchema("valueId")),
      form,
    );
    if (!parsed.ok) {
      return fail(400, {
        action: "deletePortfolioValue",
        errors: parsed.errors,
        values,
      });
    }
    const portfolio = await ownedPortfolio(
      user.id,
      account.id,
      parsed.data.portfolioId,
    );
    const belongs = (
      await orNotFoundAsync(() => listValues(user.id, portfolio.id))
    ).some((v) => v.id === parsed.data.valueId);
    if (!belongs) error(404, "Value not found.");
    try {
      await deleteValue(user.id, parsed.data.valueId);
      return {
        success: true as const,
        action: "deletePortfolioValue" as const,
      };
    } catch (err) {
      return ledgerFailure("deletePortfolioValue", err, values);
    }
  },
};
