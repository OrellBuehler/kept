import { z } from "zod";
import {
  AMOUNT_SIGNS,
  CATEGORY_ICONS,
  CATEGORY_KINDS,
} from "$lib/category-types";
import {
  applyRulesToUncategorized,
  categoryInputSchema,
  createCategory,
  createRule,
  deleteCategory,
  deleteRule,
  getCategory,
  listRules,
  ruleInputSchema,
  updateCategory,
  updateRule,
} from "$lib/server/categories";
import { listCategoryDtos, listQuery } from "$lib/server/external-api/catalog";
import { notFound } from "$lib/server/ledger/errors";
import { categoryAllowed } from "$lib/server/ledger/visibility";
import { idInput, MCP_DEFAULT_LIMIT, pagingInput } from "../format";
import { parseInput } from "../parse";
import { defineTool, holds } from "../tool";

const REVERTIBLE =
  "The change is recorded in Kept's change log and can be reverted there.";

const categoryFields = {
  name: z.string().min(1).max(60).describe("Unique among the categories."),
  kind: z.enum(CATEGORY_KINDS).describe("expense or income."),
  parentId: z
    .string()
    .max(64)
    .nullish()
    .describe(
      "Id of a top-level category of the same kind to nest under (one level only). Null or omitted: top level.",
    ),
  color: z.string().max(7).nullish().describe("Colour as #rrggbb."),
  icon: z.enum(CATEGORY_ICONS).nullish().describe("An icon from the list."),
};

const ruleFields = {
  categoryId: idInput("category the rule files payments under"),
  priority: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .optional()
    .describe("Lower runs first; the first matching rule wins. Default 100."),
  counterpartyContains: z
    .string()
    .max(100)
    .nullish()
    .describe("Case-insensitive text in the counterparty name."),
  descriptionContains: z
    .string()
    .max(100)
    .nullish()
    .describe("Case-insensitive text in the description."),
  counterpartyIban: z
    .string()
    .max(34)
    .nullish()
    .describe("The counterparty's IBAN."),
  amountSign: z
    .enum(AMOUNT_SIGNS)
    .nullish()
    .describe("income (incoming) or expense (outgoing) only."),
};

const asForm = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v === null || v === undefined ? "" : String(v),
    ]),
  );

export const categoryTools = [
  defineTool({
    name: "list_categories",
    title: "List categories",
    description:
      "Lists the owner's categories for payments: id, name, kind (expense or income), the parent category id for a subcategory (null for top level), colour. Categories nest one level. Use the id as categoryId in list_transactions and update_transactions. A connection limited to some categories only sees those.",
    scopes: ["categories:read"],
    annotations: { readOnlyHint: true },
    input: { ...pagingInput },
    run: async (ctx, args) => {
      const page = await listCategoryDtos(
        ctx.userId,
        ctx.grant,
        listQuery.parse({
          limit: String(args.limit ?? MCP_DEFAULT_LIMIT),
          cursor: args.cursor,
        }),
      );
      return {
        items: page.items.map((c) => ({
          id: c.id,
          name: c.name,
          parentId: c.parentId,
          kind: c.kind,
          color: c.color,
        })),
        nextCursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: "list_category_rules",
    title: "List category rules",
    description:
      "Lists the rules that file new payments under a category automatically, in the order they are applied (lowest priority number first, the first matching rule wins). A rule matches when all its conditions hold: counterparty text, description text, a counterparty IBAN (only whether one is set is shown), income or expense. Not available to a connection limited to some accounts: the rules reveal counterparties of all accounts.",
    scopes: ["categories:read"],
    unavailableWhen: ["accounts"],
    annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => ({
      items: (await listRules(ctx.userId))
        .filter((r) => categoryAllowed(ctx.grant, r.categoryId))
        .map((r) => ({
          id: r.id,
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          priority: r.priority,
          counterpartyContains: r.counterpartyContains,
          descriptionContains: r.descriptionContains,
          matchesIban: r.counterpartyIban !== null,
          amountSign: r.amountSign,
        })),
    }),
  }),

  defineTool({
    name: "create_category",
    title: "Create a category",
    description: `Creates a category (optionally under a top-level category of the same kind). Returns it. ${REVERTIBLE}`,
    scopes: ["categories:write"],
    annotations: { readOnlyHint: false, destructiveHint: false },
    input: categoryFields,
    run: async (ctx, args) => {
      const input = parseInput(categoryInputSchema, asForm(args));
      const c = await createCategory(ctx.userId, input);
      return { id: c.id, name: c.name, kind: c.kind, parentId: c.parentId };
    },
  }),

  defineTool({
    name: "update_category",
    title: "Update a category",
    description: `Renames or recolours a category, changes its kind or moves it under another top-level category; fields you leave out stay, null clears one. Returns it (only its id when the connection may not read categories). ${REVERTIBLE}`,
    scopes: ["categories:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {
      categoryId: idInput("category"),
      name: categoryFields.name.optional(),
      kind: categoryFields.kind.optional(),
      parentId: categoryFields.parentId,
      color: categoryFields.color,
      icon: categoryFields.icon,
    },
    run: async (ctx, { categoryId, ...changes }) => {
      const current = await getCategory(ctx.userId, categoryId);
      const input = parseInput(
        categoryInputSchema,
        asForm({
          name: current.name,
          kind: current.kind,
          parentId: current.parentId,
          color: current.color,
          icon: current.icon,
          ...Object.fromEntries(
            Object.entries(changes).filter(([, v]) => v !== undefined),
          ),
        }),
      );
      const c = await updateCategory(ctx.userId, categoryId, input);
      // A write permission must not be a way to read a category by id.
      return holds(ctx, "categories:read")
        ? { id: c.id, name: c.name, kind: c.kind, parentId: c.parentId }
        : { id: c.id };
    },
  }),

  defineTool({
    name: "delete_category",
    title: "Delete a category",
    description:
      "Deletes a category: its payments become uncategorized, its rules and budgets are removed, and its subcategories become top level. Destructive, but reverting the deletion in Kept's change log restores the category with its payments, rules and budgets.",
    scopes: ["categories:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    input: { categoryId: idInput("category") },
    run: async (ctx, { categoryId }) => {
      await deleteCategory(ctx.userId, categoryId);
      return { deleted: true, categoryId };
    },
  }),

  defineTool({
    name: "create_category_rule",
    title: "Create a category rule",
    description: `Creates a rule that files matching payments under a category when they are imported or when apply_category_rules runs. At least one condition is required. It does not change existing payments by itself. Returns the rule id. ${REVERTIBLE}`,
    scopes: ["categories:write"],
    annotations: { readOnlyHint: false, destructiveHint: false },
    input: ruleFields,
    run: async (ctx, args) => {
      const input = parseInput(
        ruleInputSchema,
        asForm({ ...args, priority: args.priority ?? "" }),
      );
      const rule = await createRule(ctx.userId, input);
      return { id: rule.id };
    },
  }),

  defineTool({
    name: "update_category_rule",
    title: "Update a category rule",
    description: `Changes a rule's category, priority or conditions; fields you leave out stay, null clears a condition. Returns the rule id. ${REVERTIBLE}`,
    scopes: ["categories:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {
      ruleId: idInput("rule"),
      ...ruleFields,
      categoryId: ruleFields.categoryId.optional(),
    },
    run: async (ctx, { ruleId, ...changes }) => {
      const current = (await listRules(ctx.userId)).find(
        (r) => r.id === ruleId,
      );
      if (!current) throw notFound("Rule");
      const input = parseInput(
        ruleInputSchema,
        asForm({
          categoryId: current.categoryId,
          priority: current.priority,
          counterpartyContains: current.counterpartyContains,
          descriptionContains: current.descriptionContains,
          counterpartyIban: current.counterpartyIban,
          amountSign: current.amountSign,
          ...Object.fromEntries(
            Object.entries(changes).filter(([, v]) => v !== undefined),
          ),
        }),
      );
      await updateRule(ctx.userId, ruleId, input);
      return { id: ruleId };
    },
  }),

  defineTool({
    name: "delete_category_rule",
    title: "Delete a category rule",
    description: `Deletes a rule. Payments already filed by it keep their category. Destructive, but ${REVERTIBLE.toLowerCase()}`,
    scopes: ["categories:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    input: { ruleId: idInput("rule") },
    run: async (ctx, { ruleId }) => {
      await deleteRule(ctx.userId, ruleId);
      return { deleted: true, ruleId };
    },
  }),

  defineTool({
    name: "apply_category_rules",
    title: "Apply category rules to uncategorized payments",
    description:
      "Runs all category rules over every payment without a category and files the matching ones. Payments that already have a category are never touched, so a category set by hand always wins. Returns how many payments were scanned and filed. A bulk change, but the whole run is one entry in Kept's change log and can be reverted there (as long as those payments were not changed since).",
    scopes: ["categories:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    input: {},
    run: async (ctx) => {
      return await applyRulesToUncategorized(ctx.userId);
    },
  }),
];
