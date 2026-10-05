import { fail } from "@sveltejs/kit";
import { desc, eq } from "drizzle-orm";
import { privateNetworkAllowed } from "$lib/server/net/private-network";
import { requireUser } from "$lib/server/auth/guards";
import { BILL_STATUSES } from "$lib/bill-types";
import { todayLocal } from "$lib/server/bills/dates";
import { buildReport, reportKindSchema } from "$lib/server/reports";
import { z } from "zod";
import { getDB, paperlessDocuments } from "$lib/server/db";
import {
  PaperlessError,
  describeError,
  messageForCode,
} from "$lib/server/integrations/paperless/client";
import {
  MIN_PAPERLESS_VERSION,
  deleteConnection,
  getConnection,
  listCustomFields,
  listSavedViews,
  listTags,
  resolveSource,
  rotateWebhookSecret,
  setBillSourceRow,
  setEnabled,
  setFieldMapping,
  testConnection,
  type CustomFieldOption,
  type SavedViewOption,
  type TagOption,
} from "$lib/server/integrations/paperless/connection";
import { saveConnectionVerified } from "$lib/server/integrations/paperless/identity";
import {
  mappingFormSchema,
  saveFormSchema,
  sourceFormSchema,
  toggleFormSchema,
} from "$lib/server/integrations/paperless/forms";
import {
  listUploads,
  uploadReport,
} from "$lib/server/integrations/paperless/reports";
import {
  webhookUrl,
  workflowRecipe,
} from "$lib/server/integrations/paperless/setup";
import { syncConnection } from "$lib/server/integrations/paperless/sync";
import { listAccounts } from "$lib/server/ledger/accounts";
import { ledgerFailure } from "$lib/server/ledger/http";
import { parseForm, safeValues } from "$lib/server/forms";
import type { Actions, PageServerLoad } from "./$types";

interface Lookups {
  tags: TagOption[] | null;
  savedViews: SavedViewOption[] | null;
  customFields: CustomFieldOption[] | null;
  /** Message per list that could not be loaded (e.g. a token without permission: enter ids by hand). */
  errors: {
    tags: string | null;
    savedViews: string | null;
    customFields: string | null;
  };
}

async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: describeError(err) };
  }
}

async function loadLookups(userId: string): Promise<Lookups> {
  const [tags, views, fields] = await Promise.all([
    attempt(() => listTags(userId)),
    attempt(() => listSavedViews(userId)),
    attempt(() => listCustomFields(userId)),
  ]);
  return {
    tags: tags.value,
    savedViews: views.value,
    customFields: fields.value,
    errors: {
      tags: tags.error,
      savedViews: views.error,
      customFields: fields.error,
    },
  };
}

const NOTES = {
  privateHosts:
    "Private, LAN and localhost addresses are allowed on purpose: Kept and Paperless are self-hosted, and every user of this Kept instance is trusted by whoever runs it.",
} as const;

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const view = await getConnection(user.id);
  const uploads = await listUploads(user.id);
  if (!view) {
    return {
      connection: null,
      minVersion: MIN_PAPERLESS_VERSION,
      billStatuses: BILL_STATUSES,
      notes: NOTES,
      webhookUrl: null,
      recipe: null,
      lastSync: null,
      recentDocuments: [],
      uploads,
      accounts: [],
      lookups: null,
    };
  }
  const { webhookToken, ...connection } = view;
  const recentDocuments = (
    await getDB()
      .select()
      .from(paperlessDocuments)
      .where(eq(paperlessDocuments.userId, user.id))
      .orderBy(desc(paperlessDocuments.updatedAt))
      .limit(20)
  ).map((d) => ({
    id: d.id,
    paperlessId: d.paperlessId,
    status: d.status,
    error: d.error,
    billId: d.billId,
    updatedAt: d.updatedAt.getTime(),
    paperlessUrl: `${connection.baseUrl}/documents/${d.paperlessId}/details`,
  }));
  return {
    connection,
    minVersion: MIN_PAPERLESS_VERSION,
    billStatuses: BILL_STATUSES,
    notes: NOTES,
    webhookUrl: webhookUrl(url.origin, webhookToken),
    recipe: workflowRecipe({
      origin: url.origin,
      webhookToken,
      tagName:
        connection.billSource?.kind === "tag"
          ? connection.billSource.label
          : null,
    }),
    lastSync: {
      at: connection.lastSyncAt,
      error: connection.lastError,
      message: connection.lastError
        ? messageForCode(connection.lastError)
        : null,
    },
    recentDocuments,
    uploads,
    accounts: (await listAccounts(user.id)).map((a) => ({
      id: a.id,
      name: a.name,
      archived: a.archived,
    })),
    // Streamed: Paperless may be slow or down, which must not block the page.
    lookups: loadLookups(user.id),
  };
};

/** Expected failures of a form action: validation, missing rows, Paperless problems. */
function actionFailure(
  action: string,
  err: unknown,
  values: Record<string, string> = {},
) {
  if (err instanceof PaperlessError) {
    return fail(400, {
      action,
      errors: { form: [err.message] },
      values,
    });
  }
  return ledgerFailure(action, err, values);
}

const reportFormSchema = z.object({
  kind: reportKindSchema,
  account: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

async function secretRecipe(origin: string, userId: string, secret: string) {
  const view = await getConnection(userId);
  if (!view) return null;
  return workflowRecipe({
    origin,
    webhookToken: view.webhookToken,
    tagName: view.billSource?.kind === "tag" ? view.billSource.label : null,
    secret,
  });
}

export const actions: Actions = {
  save: async ({ locals, request, url }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["baseUrl"]);
    const parsed = parseForm(saveFormSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "save", errors: parsed.errors, values });
    }
    try {
      const { webhookSecret } = await saveConnectionVerified(user.id, {
        ...parsed.data,
        allowPrivateNetwork: privateNetworkAllowed(user.role),
      });
      // The connection is saved either way; the test only tells the user at once whether it works.
      let test:
        | { result: Awaited<ReturnType<typeof testConnection>> }
        | { error: string };
      try {
        test = { result: await testConnection(user.id) };
      } catch (err) {
        test = { error: describeError(err) };
      }
      return {
        success: true as const,
        action: "save" as const,
        webhookSecret,
        recipe: webhookSecret
          ? await secretRecipe(url.origin, user.id, webhookSecret)
          : null,
        test,
      };
    } catch (err) {
      return actionFailure("save", err, values);
    }
  },

  test: async ({ locals }) => {
    const user = requireUser(locals);
    try {
      const result = await testConnection(user.id);
      return { success: true as const, action: "test" as const, result };
    } catch (err) {
      return actionFailure("test", err);
    }
  },

  setSource: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["kind", "id"]);
    const parsed = parseForm(sourceFormSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "setSource", errors: parsed.errors, values });
    }
    try {
      const { label, translation } = await resolveSource(
        user.id,
        parsed.data.kind,
        parsed.data.id,
      );
      if (translation && !translation.ok) {
        return fail(400, {
          action: "setSource",
          errors: { id: [translation.message] },
          values,
        });
      }
      await setBillSourceRow(user.id, {
        kind: parsed.data.kind,
        id: parsed.data.id,
        label,
      });
      return { success: true as const, action: "setSource" as const };
    } catch (err) {
      if (err instanceof PaperlessError && err.code === "not_found") {
        return fail(400, {
          action: "setSource",
          errors: { id: ["Paperless does not know this tag or saved view."] },
          values,
        });
      }
      return actionFailure("setSource", err, values);
    }
  },

  setMapping: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, [
      "amount",
      "dueDate",
      "reference",
      "status",
      ...BILL_STATUSES.map((s) => `statusValue_${s}`),
    ]);
    const parsed = parseForm(mappingFormSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "setMapping", errors: parsed.errors, values });
    }
    try {
      await setFieldMapping(user.id, parsed.data);
      return { success: true as const, action: "setMapping" as const };
    } catch (err) {
      return actionFailure("setMapping", err, values);
    }
  },

  rotateSecret: async ({ locals, url }) => {
    const user = requireUser(locals);
    try {
      const webhookSecret = await rotateWebhookSecret(user.id);
      return {
        success: true as const,
        action: "rotateSecret" as const,
        webhookSecret,
        recipe: await secretRecipe(url.origin, user.id, webhookSecret),
      };
    } catch (err) {
      return actionFailure("rotateSecret", err);
    }
  },

  syncNow: async ({ locals }) => {
    const user = requireUser(locals);
    try {
      const result = await syncConnection(user.id);
      if (result.error !== null) {
        return fail(400, {
          action: "syncNow",
          errors: { form: [messageForCode(result.error)] },
          result,
        });
      }
      return { success: true as const, action: "syncNow" as const, result };
    } catch (err) {
      return actionFailure("syncNow", err);
    }
  },

  disconnect: async ({ locals }) => {
    const user = requireUser(locals);
    try {
      await deleteConnection(user.id);
      return { success: true as const, action: "disconnect" as const };
    } catch (err) {
      return actionFailure("disconnect", err);
    }
  },

  uploadReport: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["kind", "account", "from", "to"]);
    if (!(await getConnection(user.id))) {
      return fail(400, {
        action: "uploadReport",
        errors: { form: ["Connect Paperless first."] },
        values,
      });
    }
    const parsed = parseForm(reportFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "uploadReport",
        errors: parsed.errors,
        values,
      });
    }
    const { kind, account, from, to } = parsed.data;
    try {
      const built = await buildReport(user.id, kind, { account, from, to });
      const upload = await uploadReport(user.id, {
        bytes: built.bytes,
        fileName: built.fileName,
        title: built.title,
        created: todayLocal(),
        kind,
      });
      return {
        success: true as const,
        action: "uploadReport" as const,
        alreadyUploaded: upload.alreadyUploaded,
        upload: {
          id: upload.id,
          status: upload.status,
          paperlessDocumentId: upload.paperlessDocumentId,
        },
      };
    } catch (err) {
      return actionFailure("uploadReport", err, values);
    }
  },

  toggle: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const parsed = parseForm(toggleFormSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "toggle",
        errors: parsed.errors,
        values: safeValues(form, ["enabled"]),
      });
    }
    try {
      await setEnabled(user.id, parsed.data.enabled);
      return { success: true as const, action: "toggle" as const };
    } catch (err) {
      return actionFailure("toggle", err);
    }
  },
};
