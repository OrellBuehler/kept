import { fail } from "@sveltejs/kit";
import { desc, eq } from "drizzle-orm";
import { requireUser } from "$lib/server/auth/guards";
import { BILL_STATUSES } from "$lib/bill-types";
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
  saveConnection,
  setBillSourceRow,
  setEnabled,
  setFieldMapping,
  testConnection,
  type CustomFieldOption,
  type SavedViewOption,
  type TagOption,
} from "$lib/server/integrations/paperless/connection";
import {
  mappingFormSchema,
  saveFormSchema,
  sourceFormSchema,
  toggleFormSchema,
} from "$lib/server/integrations/paperless/forms";
import { listUploads } from "$lib/server/integrations/paperless/reports";
import {
  webhookUrl,
  workflowRecipe,
} from "$lib/server/integrations/paperless/setup";
import { syncConnection } from "$lib/server/integrations/paperless/sync";
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

export const load: PageServerLoad = ({ locals, url }) => {
  const user = requireUser(locals);
  const view = getConnection(user.id);
  const uploads = listUploads(user.id);
  if (!view) {
    return {
      connection: null,
      minVersion: MIN_PAPERLESS_VERSION,
      billStatuses: BILL_STATUSES,
      webhookUrl: null,
      recipe: null,
      lastSync: null,
      recentDocuments: [],
      uploads,
      lookups: null,
    };
  }
  const { webhookToken, ...connection } = view;
  const recentDocuments = getDB()
    .select()
    .from(paperlessDocuments)
    .where(eq(paperlessDocuments.userId, user.id))
    .orderBy(desc(paperlessDocuments.updatedAt))
    .limit(20)
    .all()
    .map((d) => ({
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

function secretRecipe(origin: string, userId: string, secret: string) {
  const view = getConnection(userId);
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
      const { webhookSecret } = saveConnection(user.id, parsed.data);
      return {
        success: true as const,
        action: "save" as const,
        webhookSecret,
        recipe: webhookSecret
          ? secretRecipe(url.origin, user.id, webhookSecret)
          : null,
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
      setBillSourceRow(user.id, {
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
      setFieldMapping(user.id, parsed.data);
      return { success: true as const, action: "setMapping" as const };
    } catch (err) {
      return actionFailure("setMapping", err, values);
    }
  },

  rotateSecret: ({ locals, url }) => {
    const user = requireUser(locals);
    try {
      const webhookSecret = rotateWebhookSecret(user.id);
      return {
        success: true as const,
        action: "rotateSecret" as const,
        webhookSecret,
        recipe: secretRecipe(url.origin, user.id, webhookSecret),
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

  disconnect: ({ locals }) => {
    const user = requireUser(locals);
    try {
      deleteConnection(user.id);
      return { success: true as const, action: "disconnect" as const };
    } catch (err) {
      return actionFailure("disconnect", err);
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
      setEnabled(user.id, parsed.data.enabled);
      return { success: true as const, action: "toggle" as const };
    } catch (err) {
      return actionFailure("toggle", err);
    }
  },
};
