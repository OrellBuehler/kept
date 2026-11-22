import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { BILL_KINDS, BILL_REFERENCE_TYPES } from "$lib/bill-types";
import { billAllocations, getDB } from "$lib/server/db";
import { listBillAllocations } from "$lib/server/bills/allocations";
import {
  createBill,
  deleteBill,
  getBill,
  setBillCancelled,
  updateBill,
} from "$lib/server/bills/bills";
import { BILL_LIST_STATUSES } from "$lib/server/bills/list";
import { billInputSchema } from "$lib/server/bills/schemas";
import {
  billsQuery,
  getBillDto,
  listBillDtos,
} from "$lib/server/external-api/bills";
import { LedgerError } from "$lib/server/ledger/errors";
import { getPreferences } from "$lib/server/preferences";
import {
  accountAllowed,
  isRestricted,
  visibleTransactionIds,
} from "$lib/server/ledger/visibility";
import { billOut } from "../dto";
import {
  dateString,
  decimal,
  decimalOrNull,
  idInput,
  MCP_DEFAULT_LIMIT,
  pagingInput,
} from "../format";
import { parseInput } from "../parse";
import { defineTool, holds, requireAccount, type ToolContext } from "../tool";

const REVERTIBLE =
  "The change is recorded in Kept's change log and can be reverted there.";

const billFields = {
  kind: z
    .enum(BILL_KINDS)
    .optional()
    .describe(
      "invoice (money you owe, paid by outgoing payments) or credit_note (money owed to you). Default invoice.",
    ),
  creditorName: z
    .string()
    .max(140)
    .nullish()
    .describe("Who issued the bill. Needed unless creditorIban is given."),
  creditorIban: z
    .string()
    .max(40)
    .nullish()
    .describe("The creditor's IBAN, to match payments by it."),
  amount: z
    .string()
    .max(30)
    .nullish()
    .describe(
      'Amount as a decimal string in the bill currency, e.g. "123.45". Must be greater than zero. Leave out for an open-amount bill.',
    ),
  currency: z
    .string()
    .length(3)
    .optional()
    .describe("ISO 4217 code such as CHF. Defaults to the owner's currency."),
  issueDate: dateString.nullish().describe("YYYY-MM-DD"),
  dueDate: dateString.nullish().describe("YYYY-MM-DD, not before issueDate."),
  reference: z
    .string()
    .max(40)
    .nullish()
    .describe(
      "QR reference (27 digits) or creditor reference (RF...), used to match payments.",
    ),
  referenceType: z.enum(BILL_REFERENCE_TYPES).nullish(),
  message: z.string().max(500).nullish(),
  invoiceNumber: z.string().max(100).nullish(),
  expectedAccountId: z
    .string()
    .max(64)
    .nullish()
    .describe("Id of the account the bill is expected to be paid from."),
  notes: z.string().max(2000).nullish(),
  taxYear: z
    .number()
    .int()
    .min(1900)
    .max(2200)
    .nullish()
    .describe("The tax year the bill counts for, when it does."),
};

type BillFieldValues = {
  [K in keyof typeof billFields]?: z.infer<(typeof billFields)[K]>;
};

/** The form-shaped values the bill schema parses; null and undefined become "". */
function asForm(values: BillFieldValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  return out;
}

/** A restricted connection may only name accounts it can see. */
function checkExpectedAccount(
  ctx: Parameters<typeof requireAccount>[0],
  accountId: string | null | undefined,
) {
  if (accountId) requireAccount(ctx, accountId);
}

/**
 * What a change to an existing bill answers: the bill when the connection may
 * read bills, else only its id (a write permission must not be a way to read a
 * bill by id).
 */
async function billAfterChange(ctx: ToolContext, billId: string) {
  return holds(ctx, "bills:read")
    ? billOut(await getBillDto(ctx.userId, billId, ctx.origin))
    : { id: billId };
}

export const billTools = [
  defineTool({
    name: "list_bills",
    title: "List bills",
    description:
      "Lists the owner's bills (invoices and credit notes), earliest due date first, undated bills last. Each bill has its computed status (open, partially_paid, paid, overpaid, credit_due, cancelled), paidAmount and remainingAmount: the sum of the payments allocated to it, which counts payments of any account. Amounts are decimal strings in the bill's currency. Use the bill id with get_bill, list_payment_candidates, allocate_payment.",
    scopes: ["bills:read"],
    annotations: { readOnlyHint: true },
    input: {
      status: z
        .array(z.enum(BILL_LIST_STATUSES))
        .min(1)
        .optional()
        .describe(
          "Filter: open (unpaid or partly paid, not overdue), overdue, paid, refund (credit note to receive or overpaid invoice), cancelled, all. Default all.",
        ),
      dueFrom: dateString.optional().describe("Due on or after (YYYY-MM-DD)."),
      dueTo: dateString.optional().describe("Due on or before (YYYY-MM-DD)."),
      q: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Free text over creditor, invoice number, notes or an exact amount.",
        ),
      ...pagingInput,
    },
    run: async (ctx, args) => {
      const parsed = billsQuery.parse({
        limit: String(args.limit ?? MCP_DEFAULT_LIMIT),
        cursor: args.cursor,
        status: args.status?.join(","),
        dueFrom: args.dueFrom,
        dueTo: args.dueTo,
        q: args.q,
      });
      const page = await listBillDtos(
        ctx.userId,
        parsed,
        ctx.origin,
        ctx.today,
        { returnedFieldsOnly: true },
      );
      return { items: page.items.map(billOut), nextCursor: page.nextCursor };
    },
  }),

  defineTool({
    name: "get_bill",
    title: "Get a bill",
    description:
      "Returns one bill with its status and the payments allocated to it (allocation id, payment id, amount allocated and, when the connection may also read transactions, the payment's booking date, counterparty and account). Amounts are decimal strings in the bill's currency. A connection limited to some accounts or categories only sees the allocations of payments it can see; paidAmount still counts all of them.",
    scopes: ["bills:read"],
    annotations: { readOnlyHint: true },
    input: { billId: idInput("bill") },
    run: async (ctx, { billId }) => {
      const dto = await getBillDto(ctx.userId, billId, ctx.origin);
      const bill = await getBill(ctx.userId, billId);
      const allocations = await listBillAllocations(ctx.userId, billId);
      const visible = await visibleTransactionIds(
        ctx.userId,
        ctx.grant,
        allocations.map((a) => a.transaction.id),
      );
      const withPayments = holds(ctx, "transactions:read");
      return {
        ...billOut(dto),
        cancelled: bill.cancelled,
        taxYear: bill.taxYear,
        expectedAccountId:
          bill.expectedAccountId !== null &&
          accountAllowed(ctx.grant, bill.expectedAccountId)
            ? bill.expectedAccountId
            : null,
        allocations: allocations
          .filter((a) => visible.has(a.transaction.id))
          .map((a) => ({
            allocationId: a.id,
            paymentId: a.transaction.id,
            amount: decimal(a.amount, bill.currency),
            origin: a.origin === "auto" ? "automatic match" : "by the user",
            // The payment's own data belongs to transactions:read.
            ...(withPayments
              ? {
                  bookingDate: a.transaction.bookingDate,
                  counterpartyName: a.transaction.counterpartyName,
                  accountId: a.transaction.accountId,
                }
              : {}),
          })),
      };
    },
  }),

  defineTool({
    name: "create_bill",
    title: "Create a bill",
    description: `Creates a bill (invoice or credit note) without a document. Returns the new bill. Give a creditor name or IBAN; amount is a decimal string. The bill is not matched to payments automatically: use list_match_suggestions or list_payment_candidates afterwards. ${REVERTIBLE}`,
    scopes: ["bills:write"],
    annotations: { readOnlyHint: false, destructiveHint: false },
    input: billFields,
    run: async (ctx, args) => {
      checkExpectedAccount(ctx, args.expectedAccountId);
      const currency =
        args.currency ?? (await getPreferences(ctx.userId)).defaultCurrency;
      const input = parseInput(billInputSchema, asForm({ ...args, currency }));
      const bill = await createBill(ctx.userId, input);
      return billOut(await getBillDto(ctx.userId, bill.id, ctx.origin));
    },
  }),

  defineTool({
    name: "update_bill",
    title: "Update a bill",
    description: `Changes fields of a bill; fields you leave out stay as they are, null clears one. The type and currency cannot change once payments are allocated. Returns the updated bill (only its id when the connection may not read bills). ${REVERTIBLE}`,
    scopes: ["bills:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: { billId: idInput("bill"), ...billFields },
    run: async (ctx, { billId, ...changes }) => {
      checkExpectedAccount(ctx, changes.expectedAccountId);
      const current = await getBill(ctx.userId, billId);
      const merged = parseInput(
        billInputSchema,
        asForm({
          kind: current.kind,
          creditorName: current.creditorName,
          creditorIban: current.creditorIban,
          amount: decimalOrNull(current.amount, current.currency),
          currency: current.currency,
          issueDate: current.issueDate,
          dueDate: current.dueDate,
          reference: current.reference,
          referenceType: current.referenceType,
          message: current.message,
          invoiceNumber: current.invoiceNumber,
          expectedAccountId: current.expectedAccountId,
          notes: current.notes,
          taxYear: current.taxYear,
          ...Object.fromEntries(
            Object.entries(changes).filter(([, v]) => v !== undefined),
          ),
        }),
      );
      await updateBill(ctx.userId, billId, merged);
      return await billAfterChange(ctx, billId);
    },
  }),

  defineTool({
    name: "set_bill_cancelled",
    title: "Cancel or reinstate a bill",
    description: `Cancels a bill (it no longer takes payments and counts as cancelled) or reinstates a cancelled one. Allocated payments stay allocated. Returns the bill (only its id when the connection may not read bills). ${REVERTIBLE}`,
    scopes: ["bills:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: {
      billId: idInput("bill"),
      cancelled: z.boolean().describe("true to cancel, false to reinstate."),
    },
    run: async (ctx, { billId, cancelled }) => {
      await setBillCancelled(ctx.userId, billId, cancelled);
      return await billAfterChange(ctx, billId);
    },
  }),

  defineTool({
    name: "delete_bill",
    title: "Delete a bill",
    description: `Deletes a bill together with its payment allocations. The payments themselves stay, and so does the bill's uploaded document file: Kept keeps it for 30 days so that the delete can be undone, then removes it if no bill uses it. A connection limited to some accounts or categories cannot delete a bill that has payments it cannot see allocated. Destructive, but reverting it in Kept's change log restores the bill, its allocations and its document.`,
    scopes: ["bills:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    input: { billId: idInput("bill") },
    run: async (ctx, { billId }) => {
      await getBill(ctx.userId, billId);
      if (isRestricted(ctx.grant)) {
        const allocated = await getDB()
          .select({ transactionId: billAllocations.transactionId })
          .from(billAllocations)
          .where(
            and(
              eq(billAllocations.userId, ctx.userId),
              eq(billAllocations.billId, billId),
            ),
          );
        const visible = await visibleTransactionIds(
          ctx.userId,
          ctx.grant,
          allocated.map((a) => a.transactionId),
        );
        if (allocated.some((a) => !visible.has(a.transactionId))) {
          throw new LedgerError(
            "invalid",
            "This bill has payments allocated that this connection cannot see, so it cannot delete it.",
          );
        }
      }
      await deleteBill(ctx.userId, billId);
      return { deleted: true, billId };
    },
  }),
];
