import { z } from "zod";
import { assignCategory } from "$lib/server/categories";
import {
  getTransactionDetail,
  listTransactionDetails,
  transactionsQuery,
} from "$lib/server/external-api/transactions";
import { setTransactionNote } from "$lib/server/ledger/transactions";
import { transactionNoteSchema } from "$lib/server/ledger/schemas";
import { LedgerError } from "$lib/server/ledger/errors";
import { paymentChangeOut, paymentOut } from "../dto";
import { dateString, idInput, MCP_DEFAULT_LIMIT, pagingInput } from "../format";
import { parseInput } from "../parse";
import {
  defineTool,
  holds,
  requireCategory,
  requireTransaction,
  type ToolContext,
} from "../tool";

const REVERTIBLE =
  "The change is recorded in Kept's change log and can be reverted there.";

export const MAX_BATCH = 50;

const change = z
  .object({
    paymentId: idInput("payment (transaction)"),
    categoryId: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .optional()
      .describe(
        "The category to file it under, or null for none. Omit to keep it.",
      ),
    note: z
      .string()
      .max(1000)
      .nullable()
      .optional()
      .describe(
        "The owner's note on the payment; null or empty clears it. Omit to keep it.",
      ),
  })
  .strict()
  .refine((c) => c.categoryId !== undefined || c.note !== undefined, {
    message: "Give a categoryId, a note, or both.",
  });
type Change = z.infer<typeof change>;

/** Everything a change needs to pass, checked before the first one is written. */
async function checkChange(ctx: ToolContext, c: Change): Promise<void> {
  await requireTransaction(ctx, c.paymentId);
  if (c.categoryId === undefined) return;
  if (c.categoryId === null) {
    if (ctx.grant.categoryIds !== null) {
      throw new LedgerError(
        "invalid",
        "This connection may only file payments under its own categories, not remove the category.",
      );
    }
    return;
  }
  requireCategory(ctx, c.categoryId);
}

async function apply(ctx: ToolContext, c: Change): Promise<void> {
  if (c.categoryId !== undefined) {
    await assignCategory(ctx.userId, c.paymentId, c.categoryId);
  }
  if (c.note !== undefined) {
    const { note } = parseInput(transactionNoteSchema, { note: c.note });
    await setTransactionNote(ctx.userId, c.paymentId, note);
  }
}

export const transactionTools = [
  defineTool({
    name: "list_transactions",
    title: "List payments",
    description:
      "Lists bank payments (transactions), newest booking date first. Amounts are decimal strings in the payment's currency, signed from the account holder's view: outgoing is negative (\"-12.50\"). Each payment has its account id, category id (null when uncategorized), the owner's note and, when the connection may read bills, the ids of the bills it is allocated to (billIds). Filter by account, category, date range, free text, uncategorized and, with bills:read, unmatched (no bill allocated). Use the ids with get_transaction, update_transactions, allocate_payment. A connection limited to some accounts or categories only sees payments inside them.",
    scopes: ["transactions:read"],
    annotations: { readOnlyHint: true },
    input: {
      accountId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Only this account."),
      categoryId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Only this category."),
      from: dateString.optional().describe("Booked on or after (YYYY-MM-DD)."),
      to: dateString.optional().describe("Booked on or before (YYYY-MM-DD)."),
      q: z
        .string()
        .max(100)
        .optional()
        .describe("Text in the description or counterparty."),
      uncategorized: z
        .boolean()
        .optional()
        .describe(
          "true: only payments without a category; false: only with one.",
        ),
      unmatched: z
        .boolean()
        .optional()
        .describe(
          "true: only payments no bill is allocated to; false: only allocated ones.",
        ),
      ...pagingInput,
    },
    run: async (ctx, args) => {
      if (args.unmatched !== undefined && !holds(ctx, "bills:read")) {
        throw new LedgerError(
          "invalid",
          "Filtering by unmatched needs the bills:read permission.",
        );
      }
      const query = transactionsQuery.parse({
        limit: String(args.limit ?? MCP_DEFAULT_LIMIT),
        cursor: args.cursor,
        from: args.from,
        to: args.to,
        categoryId: args.categoryId,
        accountId: args.accountId,
        q: args.q,
        uncategorized:
          args.uncategorized === undefined
            ? undefined
            : String(args.uncategorized),
        unmatched:
          args.unmatched === undefined ? undefined : String(args.unmatched),
      });
      const page = await listTransactionDetails(
        ctx.userId,
        ctx.grant,
        query,
        ctx.origin,
      );
      const withBills = holds(ctx, "bills:read");
      return {
        items: page.items.map((p) => paymentOut(p, withBills)),
        nextCursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: "get_transaction",
    title: "Get a payment",
    description:
      "Returns one payment by id: account, booking date, signed decimal amount and currency, counterparty, description, the owner's note, category id and, when the connection may read bills, the bills it is allocated to.",
    scopes: ["transactions:read"],
    annotations: { readOnlyHint: true },
    input: { paymentId: idInput("payment (transaction)") },
    run: async (ctx, { paymentId }) =>
      paymentOut(
        await getTransactionDetail(
          ctx.userId,
          ctx.grant,
          paymentId,
          ctx.origin,
        ),
        holds(ctx, "bills:read"),
      ),
  }),

  defineTool({
    name: "update_transaction",
    title: "Set a payment's category or note",
    description: `Sets the category and/or the note of one payment (omit a field to keep it, null clears it). This is all it can change: a payment's amount, date, counterparty and existence are never touched. Categories come from list_categories. A category set by hand is never overwritten by category rules. Returns the payment (the full payment when the connection may also read transactions, else only its id, categoryId and note). ${REVERTIBLE}`,
    scopes: ["transactions:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {
      paymentId: idInput("payment (transaction)"),
      categoryId: z.string().min(1).max(64).nullable().optional(),
      note: z.string().max(1000).nullable().optional(),
    },
    run: async (ctx, args) => {
      const c = parseInput(change, args);
      await checkChange(ctx, c);
      await apply(ctx, c);
      const detail = await getTransactionDetail(
        ctx.userId,
        ctx.grant,
        c.paymentId,
        ctx.origin,
      );
      return holds(ctx, "transactions:read")
        ? paymentOut(detail, holds(ctx, "bills:read"))
        : paymentChangeOut(detail);
    },
  }),

  defineTool({
    name: "update_transactions",
    title: "Set category or note of several payments",
    description: `Sets category and/or note on up to ${MAX_BATCH} payments in one call (the same as update_transaction for each). Every payment and category is checked first: if any is unknown or outside this connection's access, nothing is changed. Returns how many were updated. ${REVERTIBLE}`,
    scopes: ["transactions:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {
      changes: z
        .array(change)
        .min(1)
        .max(MAX_BATCH)
        .describe(
          "One entry per payment: { paymentId, categoryId?, note? }. A payment may appear once.",
        ),
    },
    run: async (ctx, { changes }) => {
      if (new Set(changes.map((c) => c.paymentId)).size !== changes.length) {
        throw new LedgerError("invalid", "A payment may appear only once.");
      }
      for (const c of changes) await checkChange(ctx, c);
      for (const c of changes) await apply(ctx, c);
      return { updated: changes.length };
    },
  }),
];
