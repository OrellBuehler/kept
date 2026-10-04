import { fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import {
  allocateFromInput,
  listBillAllocations,
} from "$lib/server/bills/allocations";
import {
  attachDocument,
  deleteDocumentIfUnused,
  sweepUnreferencedDocuments,
  cancelBill,
  deleteBill,
  uncancelBill,
  updateBill,
} from "$lib/server/bills/bills";
import { autoMatchQuietly } from "$lib/server/bills/auto-match";
import { candidateTransactions } from "$lib/server/bills/candidates";
import { todayLocal } from "$lib/server/bills/dates";
import { pdfErrorMessage } from "$lib/server/bills/draft";
import { getDocumentMeta, storeDocument } from "$lib/server/bills/documents";
import { draftForDocument } from "$lib/server/bills/extraction";
import { readUpload, uploadFailure } from "$lib/server/bills/http";
import {
  BILL_FORM_FIELDS,
  allocateFormSchema,
  billInputSchema,
  dismissForBillFormSchema,
  removeAllocationFormSchema,
} from "$lib/server/bills/schemas";
import { billView } from "$lib/server/bills/status";
import {
  dismissSuggestion,
  getSuggestions,
  listDismissed,
  removeAllocation,
  undismissSuggestion,
} from "$lib/server/bills/suggestions";
import { parseForm, safeValues } from "$lib/server/forms";
import { listAccounts } from "$lib/server/ledger/accounts";
import { ledgerFailure, orNotFound } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

function positiveInt(value: string | null): number {
  return value !== null && /^\d{1,6}$/.test(value)
    ? Math.max(1, Number(value))
    : 1;
}

export const load: PageServerLoad = ({ locals, params, url }) => {
  const user = requireUser(locals);
  const bill = orNotFound(() =>
    billView(user.id, params.id, { today: todayLocal() }),
  );
  const q = url.searchParams.get("q")?.trim() ?? "";
  return {
    bill,
    allocations: listBillAllocations(user.id, bill.id),
    suggestions: getSuggestions(user.id, { billId: bill.id }),
    dismissed: listDismissed(user.id, bill.id),
    candidates: candidateTransactions(user.id, bill.id, {
      q,
      page: positiveInt(url.searchParams.get("page")),
    }),
    candidateQuery: q,
    accounts: listAccounts(user.id)
      .filter((a) => !a.archived || a.id === bill.expectedAccountId)
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    document: bill.documentId
      ? orNotFound(() => getDocumentMeta(user.id, bill.documentId!))
      : null,
  };
};

export const actions: Actions = {
  update: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => billView(user.id, params.id, { today: todayLocal() }));
    const form = await request.formData();
    const values = safeValues(form, BILL_FORM_FIELDS);
    const parsed = parseForm(billInputSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "update", errors: parsed.errors, values });
    }
    try {
      updateBill(user.id, params.id, parsed.data);
      autoMatchQuietly(user.id);
      return { success: true as const, action: "update" as const };
    } catch (err) {
      return ledgerFailure("update", err, values);
    }
  },

  cancel: ({ locals, params }) => {
    const user = requireUser(locals);
    orNotFound(() => cancelBill(user.id, params.id));
    return { success: true as const, action: "cancel" as const };
  },

  uncancel: ({ locals, params }) => {
    const user = requireUser(locals);
    orNotFound(() => uncancelBill(user.id, params.id));
    return { success: true as const, action: "uncancel" as const };
  },

  delete: ({ locals, params }) => {
    const user = requireUser(locals);
    orNotFound(() => deleteBill(user.id, params.id));
    redirect(303, "/bills");
  },

  allocate: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => billView(user.id, params.id, { today: todayLocal() }));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId", "amount"]);
    const parsed = parseForm(allocateFormSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "allocate", errors: parsed.errors, values });
    }
    try {
      allocateFromInput(
        user.id,
        params.id,
        parsed.data.transactionId,
        parsed.data.amount,
        "user",
      );
      return { success: true as const, action: "allocate" as const };
    } catch (err) {
      return ledgerFailure("allocate", err, values);
    }
  },

  removeAllocation: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => billView(user.id, params.id, { today: todayLocal() }));
    const form = await request.formData();
    const values = safeValues(form, ["allocationId"]);
    const parsed = parseForm(removeAllocationFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "removeAllocation",
        errors: parsed.errors,
        values,
      });
    }
    const owned = listBillAllocations(user.id, params.id).some(
      (a) => a.id === parsed.data.allocationId,
    );
    if (!owned) {
      return fail(404, {
        action: "removeAllocation",
        errors: { form: ["Allocation not found."] },
        values,
      });
    }
    try {
      removeAllocation(user.id, parsed.data.allocationId);
      return { success: true as const, action: "removeAllocation" as const };
    } catch (err) {
      return ledgerFailure("removeAllocation", err, values);
    }
  },

  dismissSuggestion: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => billView(user.id, params.id, { today: todayLocal() }));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(dismissForBillFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "dismissSuggestion",
        errors: parsed.errors,
        values,
      });
    }
    try {
      dismissSuggestion(user.id, params.id, parsed.data.transactionId);
      return { success: true as const, action: "dismissSuggestion" as const };
    } catch (err) {
      return ledgerFailure("dismissSuggestion", err, values);
    }
  },

  undismiss: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => billView(user.id, params.id, { today: todayLocal() }));
    const form = await request.formData();
    const values = safeValues(form, ["transactionId"]);
    const parsed = parseForm(dismissForBillFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "undismiss",
        errors: parsed.errors,
        values,
      });
    }
    try {
      undismissSuggestion(user.id, params.id, parsed.data.transactionId);
      return { success: true as const, action: "undismiss" as const };
    } catch (err) {
      return ledgerFailure("undismiss", err, values);
    }
  },

  attachDocument: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    orNotFound(() => billView(user.id, params.id, { today: todayLocal() }));
    const upload = await readUpload(await request.formData());
    if (!upload.ok) return uploadFailure("attachDocument", upload.message);
    sweepUnreferencedDocuments(user.id);
    let storedId: string | null = null;
    try {
      storedId = storeDocument(
        user.id,
        upload.bytes,
        upload.fileName,
        upload.mimeType,
      ).id;
      attachDocument(user.id, params.id, storedId);
      return { success: true as const, action: "attachDocument" as const };
    } catch (err) {
      deleteDocumentIfUnused(user.id, storedId);
      return ledgerFailure("attachDocument", err);
    }
  },

  reextract: async ({ locals, params }) => {
    const user = requireUser(locals);
    const bill = orNotFound(() =>
      billView(user.id, params.id, { today: todayLocal() }),
    );
    if (!bill.documentId) {
      return fail(400, {
        action: "reextract",
        errors: { form: ["This bill has no document."] },
        values: {},
      });
    }
    const { draft, extraction } = await draftForDocument(
      user.id,
      bill.documentId,
      { refresh: true },
    );
    if (!draft) {
      return fail(400, {
        action: "reextract",
        errors: {
          form: extraction.warnings.length
            ? extraction.warnings
            : [pdfErrorMessage("unreadable")],
        },
        values: {},
      });
    }
    return {
      success: true as const,
      action: "reextract" as const,
      draft,
      extraction,
    };
  },
};
