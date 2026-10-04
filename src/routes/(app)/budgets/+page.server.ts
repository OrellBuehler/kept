import { fail } from "@sveltejs/kit";
import type { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import {
  budgetInputSchema,
  budgetReport,
  createBudget,
  deleteBudget,
  idFormSchema,
  listCategories,
  monthSchema,
  updateBudget,
} from "$lib/server/categories";
import { FULL_SHARE_BPS, parseShareBasis } from "$lib/money";
import { addMonths } from "$lib/server/dashboard";
import { parseForm, safeValues } from "$lib/server/forms";
import { listAccounts } from "$lib/server/ledger/accounts";
import { localToday } from "$lib/server/ledger/balances";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

const budgetFields = ["categoryId", "currency", "amount"] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const today = localToday();
  const requested = monthSchema.safeParse(url.searchParams.get("month"));
  const month = requested.success ? requested.data : today.slice(0, 7);
  const monthStart = `${month}-01`;
  const categories = await listCategories(user.id);
  const accounts = await listAccounts(user.id);
  const basis = parseShareBasis(url.searchParams.get("basis"), "share");
  return {
    month,
    basis,
    hasShared: accounts.some((a) => !a.archived && a.shareBps < FULL_SHARE_BPS),
    currentMonth: today.slice(0, 7),
    previousMonth: addMonths(monthStart, -1).slice(0, 7),
    nextMonth: addMonths(monthStart, 1).slice(0, 7),
    report: await budgetReport(user.id, month, basis),
    categories,
    currencies: [...new Set(accounts.map((a) => a.currency))].sort(),
  };
};

function formAction<S extends z.ZodType>(
  action: string,
  schema: S,
  fields: readonly string[],
  run: (userId: string, data: z.output<S>) => unknown,
) {
  return async ({ locals, request }: RequestEvent) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, fields);
    const parsed = parseForm(schema, form);
    if (!parsed.ok) {
      return fail(400, { action, errors: parsed.errors, values });
    }
    try {
      await run(user.id, parsed.data);
      return { success: true as const, action };
    } catch (err) {
      return ledgerFailure(action, err, values);
    }
  };
}

export const actions = {
  createBudget: formAction(
    "createBudget",
    budgetInputSchema,
    budgetFields,
    (userId, data) => createBudget(userId, data),
  ),
  updateBudget: formAction(
    "updateBudget",
    budgetInputSchema.and(idFormSchema("id")),
    ["id", ...budgetFields],
    (userId, { id, ...input }) => updateBudget(userId, id, input),
  ),
  deleteBudget: formAction(
    "deleteBudget",
    idFormSchema("id"),
    ["id"],
    (userId, { id }) => deleteBudget(userId, id),
  ),
} satisfies Actions;
