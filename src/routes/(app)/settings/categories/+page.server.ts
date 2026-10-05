import { fail } from "@sveltejs/kit";
import type { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import {
  applyRulesToUncategorized,
  categoryInputSchema,
  createCategory,
  createRule,
  deleteCategory,
  deleteRule,
  idFormSchema,
  idSchema,
  listCategoriesWithCounts,
  listRules,
  ruleInputSchema,
  updateCategory,
  updateRule,
} from "$lib/server/categories";
import { parseForm, safeValues } from "$lib/server/forms";
import { ledgerFailure } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

const categoryFields = ["name", "kind", "parentId", "color", "icon"] as const;
const ruleFields = [
  "categoryId",
  "priority",
  "counterpartyContains",
  "descriptionContains",
  "counterpartyIban",
  "amountSign",
] as const;

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  return {
    categories: await listCategoriesWithCounts(user.id),
    rules: await listRules(user.id),
  };
};

function formAction<S extends z.ZodType, R extends object>(
  action: string,
  schema: S,
  fields: readonly string[],
  run: (userId: string, data: z.output<S>) => R | Promise<R>,
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
      return {
        success: true as const,
        action,
        ...(await run(user.id, parsed.data)),
      };
    } catch (err) {
      return ledgerFailure(action, err, values);
    }
  };
}

export const actions = {
  createCategory: formAction(
    "createCategory",
    categoryInputSchema,
    categoryFields,
    async (userId, data) => ({ id: (await createCategory(userId, data)).id }),
  ),
  updateCategory: formAction(
    "updateCategory",
    categoryInputSchema.extend({ id: idSchema }),
    ["id", ...categoryFields],
    async (userId, { id, ...input }) => ({
      id: (await updateCategory(userId, id, input)).id,
    }),
  ),
  deleteCategory: formAction(
    "deleteCategory",
    idFormSchema("id"),
    ["id"],
    async (userId, { id }) => {
      await deleteCategory(userId, id);
      return { id };
    },
  ),
  createRule: formAction(
    "createRule",
    ruleInputSchema,
    ruleFields,
    async (userId, data) => ({ id: (await createRule(userId, data)).id }),
  ),
  updateRule: formAction(
    "updateRule",
    // The refinement lives on the schema, so the id is parsed alongside it.
    ruleInputSchema.and(idFormSchema("id")),
    ["id", ...ruleFields],
    async (userId, { id, ...input }) => ({
      id: (await updateRule(userId, id, input)).id,
    }),
  ),
  deleteRule: formAction(
    "deleteRule",
    idFormSchema("id"),
    ["id"],
    async (userId, { id }) => {
      await deleteRule(userId, id);
      return { id };
    },
  ),
  applyRules: async ({ locals }: RequestEvent) => {
    const user = requireUser(locals);
    return {
      success: true as const,
      action: "applyRules" as const,
      ...(await applyRulesToUncategorized(user.id)),
    };
  },
} satisfies Actions;
