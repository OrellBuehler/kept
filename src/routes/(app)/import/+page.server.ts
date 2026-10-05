import { fail, redirect } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import {
  getInboxView,
  readInboxConfig,
  startInboxReview,
} from "$lib/server/inbox";
import { listRecentImports, startUpload } from "$lib/server/imports";
import { listAccounts } from "$lib/server/ledger/accounts";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const accounts = (await listAccounts(user.id))
    .filter((a) => !a.archived)
    .map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      institutionName: a.institution?.name ?? null,
      institution: a.institution,
    }));
  const requested = url.searchParams.get("account");
  return {
    accounts,
    recentImports: listRecentImports(user.id, 10),
    inbox: getInboxView(user.id, user.username),
    selectedAccountId: accounts.find((a) => a.id === requested)?.id ?? null,
  };
};

export const actions: Actions = {
  reviewInbox: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const entryId = form.get("entryId");
    const config = readInboxConfig();
    if (typeof entryId !== "string" || !config) {
      return fail(400, {
        action: "reviewInbox",
        errors: { form: ["This inbox file cannot be reviewed."] },
        values: { accountId: "" },
      });
    }
    let target: string;
    try {
      target = await startInboxReview(config, user, entryId);
    } catch (err) {
      return ledgerFailure("reviewInbox", err, { accountId: "" });
    }
    redirect(303, target);
  },
  upload: async ({ locals, request }) => {
    const user = requireUser(locals);
    let form: FormData;
    try {
      form = await request.formData();
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      return fail(400, {
        action: "upload",
        errors: { form: ["The upload could not be read."] },
        values: { accountId: "" },
      });
    }
    const accountIdRaw = form.get("accountId");
    const accountId =
      typeof accountIdRaw === "string" ? accountIdRaw.trim() : "";
    const values = { accountId };
    const errors: Record<string, string[]> = {};
    if (accountId === "") errors.accountId = ["Choose an account."];
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      errors.file = ["Choose a file to upload."];
    }
    if (Object.keys(errors).length > 0 || !(file instanceof File)) {
      return fail(400, { action: "upload", errors, values });
    }

    let target: string;
    try {
      const { meta, needsMapping } = await startUpload(
        user.id,
        accountId,
        file,
      );
      target = needsMapping
        ? `/import/${meta.id}/mapping`
        : `/import/${meta.id}`;
    } catch (err) {
      return ledgerFailure("upload", err, values);
    }
    redirect(303, target);
  },
};
