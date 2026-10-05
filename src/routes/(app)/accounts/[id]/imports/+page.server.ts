import { requireUser } from "$lib/server/auth/guards";
import { parseForm } from "$lib/server/forms";
import { getImportImpacts, listImports, undoImport } from "$lib/server/imports";
import { getAccount } from "$lib/server/ledger/accounts";
import { ledgerFailure, orNotFoundAsync } from "$lib/server/ledger/http";
import { idFormSchema } from "$lib/server/ledger/schemas";
import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  const user = requireUser(locals);
  return await orNotFoundAsync(async () => {
    const imports = await listImports(user.id, params.id);
    return {
      account: await getAccount(user.id, params.id),
      imports,
      impacts: Object.fromEntries(
        await getImportImpacts(
          user.id,
          imports.map((i) => i.id),
        ),
      ),
    };
  });
};

export const actions: Actions = {
  undo: async ({ locals, params, request }) => {
    const user = requireUser(locals);
    await orNotFoundAsync(() => getAccount(user.id, params.id));
    const parsed = parseForm(
      idFormSchema("importId"),
      await request.formData(),
    );
    if (!parsed.ok) {
      return fail(400, { action: "undo", errors: parsed.errors, values: {} });
    }
    try {
      const done = await undoImport(user.id, parsed.data.importId, params.id);
      return {
        success: true as const,
        action: "undo" as const,
        id: parsed.data.importId,
        removedTransactions: done.removedTransactions,
      };
    } catch (err) {
      return ledgerFailure("undo", err);
    }
  },
};
