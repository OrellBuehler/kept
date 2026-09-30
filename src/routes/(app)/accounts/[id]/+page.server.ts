import { error, fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import {
  archiveAccount,
  deleteAccount,
  getAccount,
  unarchiveAccount,
  updateAccount,
} from "$lib/server/ledger/accounts";
import { ledgerFailure, orNotFound } from "$lib/server/ledger/http";
import { listInstitutions } from "$lib/server/ledger/institutions";
import {
  accountInputSchema,
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
import type { Actions, PageServerLoad } from "./$types";

const accountFields = [
  "institutionId",
  "name",
  "type",
  "currency",
  "iban",
  "openingBalance",
  "openingDate",
  "sortOrder",
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

export const load: PageServerLoad = ({ locals, params, url }) => {
  const user = requireUser(locals);
  const account = orNotFound(() => getAccount(user.id, params.id));
  const query = parseListQuery(url.searchParams, account.currency);
  return {
    account,
    balance: account.balance,
    institutions: listInstitutions(user.id).map((i) => ({
      id: i.id,
      name: i.name,
    })),
    transactions: listTransactions(user.id, account.id, {
      filters: query.filters,
      page: query.page,
      pageSize: query.pageSize,
    }),
    snapshots: listSnapshots(user.id, account.id),
    filters: query.raw,
    filterErrors: query.errors,
  };
};

function ownedTransaction(userId: string, accountId: string, id: string) {
  const tx = orNotFound(() => getTransaction(userId, id));
  if (tx.accountId !== accountId) error(404, "Transaction not found.");
  return tx;
}

export const actions: Actions = {
  updateAccount: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => getAccount(user.id, params.id));
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
      updateAccount(user.id, params.id, parsed.data);
      return { success: true as const, action: "updateAccount" as const };
    } catch (err) {
      return ledgerFailure("updateAccount", err, values);
    }
  },

  archive: ({ locals, params }) => {
    const user = requireUser(locals);
    orNotFound(() => archiveAccount(user.id, params.id));
    return { success: true as const, action: "archive" as const };
  },

  unarchive: ({ locals, params }) => {
    const user = requireUser(locals);
    orNotFound(() => unarchiveAccount(user.id, params.id));
    return { success: true as const, action: "unarchive" as const };
  },

  deleteAccount: ({ locals, params }) => {
    const user = requireUser(locals);
    orNotFound(() => deleteAccount(user.id, params.id));
    redirect(303, "/accounts");
  },

  addTransaction: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = orNotFound(() => getAccount(user.id, params.id));
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
      const created = createManualTransaction(user.id, account.id, parsed.data);
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
    const account = orNotFound(() => getAccount(user.id, params.id));
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
    const existing = ownedTransaction(
      user.id,
      account.id,
      idParsed.data.transactionId,
    );
    const parsed =
      existing.source === "import"
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
      updateTransaction(user.id, existing.id, parsed.data);
      return {
        success: true as const,
        action: "updateTransaction" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("updateTransaction", err, values);
    }
  },

  deleteTransaction: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = orNotFound(() => getAccount(user.id, params.id));
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
    const existing = ownedTransaction(
      user.id,
      account.id,
      parsed.data.transactionId,
    );
    try {
      deleteTransaction(user.id, existing.id);
      return {
        success: true as const,
        action: "deleteTransaction" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("deleteTransaction", err, values);
    }
  },

  addSnapshot: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    const account = orNotFound(() => getAccount(user.id, params.id));
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
      const created = createSnapshot(user.id, account.id, parsed.data);
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
    const account = orNotFound(() => getAccount(user.id, params.id));
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
    const existing = orNotFound(() =>
      getSnapshot(user.id, parsed.data.snapshotId),
    );
    if (existing.accountId !== account.id) error(404, "Balance not found.");
    try {
      deleteSnapshot(user.id, existing.id);
      return {
        success: true as const,
        action: "deleteSnapshot" as const,
        id: existing.id,
      };
    } catch (err) {
      return ledgerFailure("deleteSnapshot", err, values);
    }
  },
};
