import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { billAllocations, first, getDB } from "$lib/server/db";
import { allocateFromInput } from "$lib/server/bills/allocations";
import { candidateTransactions } from "$lib/server/bills/candidates";
import {
  dismissSuggestion,
  getSuggestions,
  removeAllocation,
  runAutoMatching,
} from "$lib/server/bills/suggestions";
import { notFound } from "$lib/server/ledger/errors";
import { pageInMemory } from "$lib/server/external-api/http";
import { visibleTransactionIds } from "$lib/server/ledger/visibility";
import { decimal, idInput, pagingInput, MCP_DEFAULT_LIMIT } from "../format";
import { defineTool, requireTransaction } from "../tool";

const REVERTIBLE =
  "The change is recorded in Kept's change log and can be reverted there.";

export const matchTools = [
  defineTool({
    name: "list_match_suggestions",
    title: "List suggested bill and payment matches",
    description:
      "Lists pairs of an open bill and a payment that probably belong together, with the rule that found them (reference, IBAN, amount and date...), confidence (exact or high), the amount that would be allocated (decimal string in the bill's currency), whether the pair is ambiguous, and whether Kept would confirm it automatically (auto). Nothing is changed. Confirm a pair with allocate_payment (billId, paymentId) or reject it with dismiss_suggestion. Only payments this connection can see are listed.",
    scopes: ["bills:read", "transactions:read"],
    annotations: { readOnlyHint: true },
    input: {
      billId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Only suggestions for this bill."),
      ...pagingInput,
    },
    run: async (ctx, args) => {
      const all = await getSuggestions(ctx.userId, {
        billId: args.billId,
        visibility: ctx.grant,
      });
      const page = pageInMemory(
        all,
        (s) => [s.bill.dueDate, s.billId, s.transactionId],
        {
          keyLength: 3,
          limit: args.limit ?? MCP_DEFAULT_LIMIT,
          cursor: args.cursor,
        },
      );
      return {
        items: page.items.map((s) => ({
          billId: s.billId,
          paymentId: s.transactionId,
          rule: s.rule,
          confidence: s.confidence,
          amount: decimal(s.amount, s.bill.currency),
          currency: s.bill.currency,
          ambiguous: s.ambiguous,
          auto: s.auto,
          bill: {
            creditorName: s.bill.creditorName,
            invoiceNumber: s.bill.invoiceNumber,
            kind: s.bill.kind,
            amount:
              s.bill.amount === null
                ? null
                : decimal(s.bill.amount, s.bill.currency),
            dueDate: s.bill.dueDate,
          },
          payment: {
            accountId: s.transaction.accountId,
            bookingDate: s.transaction.bookingDate,
            amount: decimal(s.transaction.amount, s.transaction.currency),
            currency: s.transaction.currency,
            counterpartyName: s.transaction.counterpartyName,
            description: s.transaction.description,
          },
        })),
        nextCursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: "list_payment_candidates",
    title: "List payments that could be allocated to a bill",
    description:
      "Lists payments that could be allocated to one bill: same currency, something left unallocated, the right direction (outgoing for invoices, incoming for credit notes), newest first. For each, unallocated is the part of the payment not yet allocated and suggestedAmount the amount to allocate (decimal strings; negative for a refund of an overpayment). Pages by number. Use the payment id with allocate_payment. Only payments this connection can see are listed.",
    scopes: ["bills:read", "transactions:read"],
    annotations: { readOnlyHint: true },
    input: {
      billId: idInput("bill"),
      q: z
        .string()
        .max(200)
        .optional()
        .describe("Search counterparty, description or amount."),
      page: z.number().int().min(1).max(10_000).optional(),
    },
    run: async (ctx, { billId, q, page }) => {
      const result = await candidateTransactions(ctx.userId, billId, {
        q,
        page,
        pageSize: MCP_DEFAULT_LIMIT,
        visibility: ctx.grant,
        returnedFieldsOnly: true,
      });
      return {
        items: result.items.map((t) => ({
          paymentId: t.id,
          accountId: t.accountId,
          bookingDate: t.bookingDate,
          amount: decimal(t.amount, t.currency),
          currency: t.currency,
          counterpartyName: t.counterpartyName,
          description: t.description,
          unallocated: decimal(t.unallocated, t.currency),
          suggestedAmount: decimal(t.suggestedAmount, t.currency),
        })),
        total: result.total,
        page: result.page,
        pageCount: result.pageCount,
      };
    },
  }),

  defineTool({
    name: "allocate_payment",
    title: "Allocate a payment to a bill",
    description: `Allocates a payment (or part of one) to a bill, which settles the bill by that amount. The amount is a decimal string in the bill's currency, positive for a payment in the bill's direction (an outgoing payment for an invoice) and negative for a refund of an overpayment; take it from suggestedAmount of list_payment_candidates. Refused when it exceeds what the bill still needs or what the payment has left. Returns the allocation id. ${REVERTIBLE}`,
    scopes: ["matches:write"],
    annotations: { readOnlyHint: false, destructiveHint: false },
    input: {
      billId: idInput("bill"),
      paymentId: idInput("payment (transaction)"),
      amount: z.string().min(1).max(30).describe('e.g. "123.45"'),
    },
    run: async (ctx, { billId, paymentId, amount }) => {
      await requireTransaction(ctx, paymentId);
      const created = await allocateFromInput(
        ctx.userId,
        billId,
        paymentId,
        amount,
        "user",
      );
      return { allocationId: created.id, billId, paymentId };
    },
  }),

  defineTool({
    name: "remove_allocation",
    title: "Remove a payment allocation",
    description: `Removes an allocation of a payment from a bill (get the allocation id from get_bill). The payment and the bill stay. If automatic matching would otherwise put the pair straight back, it is dismissed so that it does not. ${REVERTIBLE}`,
    scopes: ["matches:write"],
    annotations: { readOnlyHint: false, destructiveHint: true },
    input: { allocationId: idInput("allocation") },
    run: async (ctx, { allocationId }) => {
      const row = await first(
        getDB()
          .select({ transactionId: billAllocations.transactionId })
          .from(billAllocations)
          .where(
            and(
              eq(billAllocations.userId, ctx.userId),
              eq(billAllocations.id, allocationId),
            ),
          )
          .limit(1),
      );
      if (!row) throw notFound("Allocation");
      const visible = await visibleTransactionIds(ctx.userId, ctx.grant, [
        row.transactionId,
      ]);
      if (!visible.has(row.transactionId)) throw notFound("Allocation");
      await removeAllocation(ctx.userId, allocationId);
      return { removed: true, allocationId };
    },
  }),

  defineTool({
    name: "dismiss_suggestion",
    title: "Dismiss a suggested match",
    description: `Marks a suggested bill and payment pair as not belonging together, so it is no longer suggested and never confirmed automatically. Idempotent. ${REVERTIBLE}`,
    scopes: ["matches:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {
      billId: idInput("bill"),
      paymentId: idInput("payment (transaction)"),
    },
    run: async (ctx, { billId, paymentId }) => {
      await requireTransaction(ctx, paymentId);
      await dismissSuggestion(ctx.userId, billId, paymentId);
      return { dismissed: true, billId, paymentId };
    },
  }),

  defineTool({
    name: "run_auto_match",
    title: "Run automatic matching",
    description: `Confirms every exact, unambiguous match of a bill to a payment (same reference and the amount that is still due), exactly as Kept does after an import. Returns how many allocations were created and how many suggestions are left to decide (see list_match_suggestions). A connection limited to some accounts or categories only confirms payments it can see. ${REVERTIBLE}`,
    scopes: ["matches:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {},
    run: async (ctx) => {
      const result = await runAutoMatching(ctx.userId, ctx.grant);
      return {
        matched: result.matched,
        remainingSuggestions: result.suggestions.length,
        truncated: result.truncated,
      };
    },
  }),
];
