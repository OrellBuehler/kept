import { fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import {
  createBill,
  sweepUnreferencedDocuments,
} from "$lib/server/bills/bills";
import { pdfErrorMessage } from "$lib/server/bills/draft";
import { getDocumentMeta, storeDocument } from "$lib/server/bills/documents";
import {
  cacheExtraction,
  draftForDocument,
} from "$lib/server/bills/extraction";
import { readUpload, uploadFailure } from "$lib/server/bills/http";
import {
  PdfExtractError,
  extractBillFromPdf,
} from "$lib/server/bills/pdf-extract";
import {
  BILL_FORM_FIELDS,
  billInputSchema,
  optionalDocumentIdSchema,
} from "$lib/server/bills/schemas";
import { autoMatchQuietly } from "$lib/server/bills/auto-match";
import { parseForm, safeValues } from "$lib/server/forms";
import { listAccounts } from "$lib/server/ledger/accounts";
import { ledgerFailure, orNotFound } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const accounts = listAccounts(user.id)
    .filter((a) => !a.archived)
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
  const documentId = url.searchParams.get("document");
  if (!documentId) {
    return { accounts, draft: null, documentId: null, extraction: null };
  }
  orNotFound(() => getDocumentMeta(user.id, documentId));
  const { draft, extraction } = await draftForDocument(user.id, documentId);
  return { accounts, draft, documentId, extraction };
};

export const actions: Actions = {
  upload: async ({ locals, request }) => {
    const user = requireUser(locals);
    const upload = await readUpload(await request.formData());
    if (!upload.ok) return uploadFailure("upload", upload.message);
    let extraction;
    try {
      extraction = await extractBillFromPdf(upload.bytes);
    } catch (err) {
      if (!(err instanceof PdfExtractError)) throw err;
      return uploadFailure("upload", pdfErrorMessage(err.code));
    }
    await sweepUnreferencedDocuments(user.id);
    let documentId: string;
    try {
      documentId = (
        await storeDocument(
          user.id,
          upload.bytes,
          upload.fileName,
          upload.mimeType,
        )
      ).id;
    } catch (err) {
      return ledgerFailure("upload", err);
    }
    cacheExtraction(user.id, documentId, extraction);
    redirect(303, `/bills/new?document=${encodeURIComponent(documentId)}`);
  },

  create: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, [...BILL_FORM_FIELDS, "documentId"]);
    const parsed = parseForm(billInputSchema, form);
    const doc = parseForm(optionalDocumentIdSchema, form);
    if (!parsed.ok || !doc.ok) {
      return fail(400, {
        action: "create",
        errors: {
          ...(doc.ok ? {} : doc.errors),
          ...(parsed.ok ? {} : parsed.errors),
        },
        values,
      });
    }
    let id: string;
    try {
      const documentId = doc.data.documentId;
      const extraction = documentId
        ? (await draftForDocument(user.id, documentId)).extraction
        : null;
      id = createBill(user.id, parsed.data, { documentId, extraction }).id;
    } catch (err) {
      return ledgerFailure("create", err, values);
    }
    autoMatchQuietly(user.id);
    redirect(303, `/bills/${id}`);
  },
};
