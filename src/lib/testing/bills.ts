import { createBill, type BillView } from "$lib/server/bills/bills";
import type { BillInput } from "$lib/server/bills/schemas";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";

export const billInput = (over: Partial<BillInput> = {}): BillInput => ({
  kind: "invoice",
  creditorName: "Example Supplier",
  creditorIban: null,
  amount: 10000 as BillInput["amount"],
  currency: "CHF",
  issueDate: null,
  dueDate: null,
  reference: null,
  referenceType: null,
  message: null,
  invoiceNumber: null,
  expectedAccountId: null,
  notes: null,
  taxYear: null,
  ...over,
});

export function seedBill(
  userId: string,
  over: Partial<BillInput> = {},
): BillView {
  return createBill(userId, billInput(over));
}

/** Form fields accepted by the bill create/update actions. */
export const billForm = (over: Record<string, string> = {}) => ({
  kind: "invoice",
  creditorName: "Example Supplier",
  creditorIban: EXAMPLE_IBAN,
  amount: "100.00",
  currency: "CHF",
  issueDate: "2026-09-01",
  dueDate: "2026-10-15",
  reference: "",
  referenceType: "",
  message: "",
  invoiceNumber: "",
  expectedAccountId: "",
  notes: "",
  taxYear: "",
  ...over,
});
