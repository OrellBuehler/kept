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

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  return {
    categories: listCategoriesWithCounts(user.id),
    rules: listRules(user.id),
  };
};

function formAction<S extends z.ZodType, R extends object>(
  action: string,
  schema: S,
  fields: readonly string[],
  run: (userId: string, data: z.output<S>) => R,
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
      return { success: true as const, action, ...run(user.id, parsed.data) };
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
    (userId, data) => ({ id: createCategory(userId, data).id }),
  ),
  updateCategory: formAction(
    "updateCategory",
    categoryInputSchema.extend({ id: idSchema }),
    ["id", ...categoryFields],
    (userId, { id, ...input }) => ({
      id: updateCategory(userId, id, input).id,
    }),
  ),
  deleteCategory: formAction(
    "deleteCategory",
    idFormSchema("id"),
    ["id"],
    (userId, { id }) => {
      deleteCategory(userId, id);
      return { id };
    },
  ),
  createRule: formAction(
    "createRule",
    ruleInputSchema,
    ruleFields,
    (userId, data) => ({ id: createRule(userId, data).id }),
  ),
  updateRule: formAction(
    "updateRule",
    // The refinement lives on the schema, so the id is parsed alongside it.
    ruleInputSchema.and(idFormSchema("id")),
    ["id", ...ruleFields],
    (userId, { id, ...input }) => ({ id: updateRule(userId, id, input).id }),
  ),
  deleteRule: formAction(
    "deleteRule",
    idFormSchema("id"),
    ["id"],
    (userId, { id }) => {
      deleteRule(userId, id);
      return { id };
    },
  ),
  applyRules: ({ locals }: RequestEvent) => {
    const user = requireUser(locals);
    return {
      success: true as const,
      action: "applyRules" as const,
      ...applyRulesToUncategorized(user.id),
    };
  },
} satisfies Actions;
