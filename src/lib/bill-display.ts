import { minorToInput } from "$lib/amount-input";
import type {
  BillKind,
  BillReferenceType,
  BillStatusName,
} from "$lib/bill-types";
import { formatIban } from "$lib/iban";
import type { Minor } from "$lib/money";
import { formatReference } from "$lib/references";

export const STATUS_LABELS: Record<BillStatusName, string> = {
  open: "Open",
  partially_paid: "Partially paid",
  paid: "Paid",
  overpaid: "Overpaid",
  credit_due: "Credit due",
  cancelled: "Cancelled",
};

export const KIND_LABELS: Record<BillKind, string> = {
  invoice: "Invoice",
  credit_note: "Credit note",
};

/** Token-friendly badge colours, one distinct hue per status. */
export const STATUS_CLASSES: Record<BillStatusName, string> = {
  open: "border-border bg-secondary text-secondary-foreground",
  partially_paid:
    "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300",
  paid: "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-300",
  overpaid:
    "border-transparent bg-sky-100 text-sky-900 dark:bg-sky-400/15 dark:text-sky-300",
  credit_due:
    "border-transparent bg-violet-100 text-violet-900 dark:bg-violet-400/15 dark:text-violet-300",
  cancelled: "border-border bg-muted text-muted-foreground line-through",
};

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "3 days overdue", "Due in 5 days"; null when the hint would add nothing. */
export function dueHint(bill: {
  dueInDays: number | null;
  overdue: boolean;
  status: BillStatusName;
}): string | null {
  if (bill.dueInDays === null) return null;
  if (bill.overdue) return `${plural(-bill.dueInDays, "day")} overdue`;
  if (bill.status !== "open" && bill.status !== "partially_paid") return null;
  if (bill.dueInDays === 0) return "Due today";
  if (bill.dueInDays === 1) return "Due tomorrow";
  if (bill.dueInDays > 1) return `Due in ${bill.dueInDays} days`;
  return null;
}

/** Form fields of the bill form; other error keys are folded into the form error. */
export const BILL_FIELDS = [
  "kind",
  "creditorName",
  "creditorIban",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
  "reference",
  "referenceType",
  "message",
  "invoiceNumber",
  "expectedAccountId",
  "notes",
  "taxYear",
  "documentId",
] as const;

export const REFERENCE_TYPE_LABELS: Record<BillReferenceType | "", string> = {
  "": "Detect automatically",
  QRR: "QR reference (QRR)",
  SCOR: "Creditor reference (SCOR)",
  NON: "No reference (NON)",
};

/** Everything the bill form edits, as the strings typed into the inputs. */
export interface BillFormValues {
  kind: BillKind;
  creditorName: string;
  creditorIban: string;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  reference: string;
  referenceType: BillReferenceType | "";
  message: string;
  invoiceNumber: string;
  expectedAccountId: string;
  notes: string;
  taxYear: string;
}

export function emptyBillValues(): BillFormValues {
  return {
    kind: "invoice",
    creditorName: "",
    creditorIban: "",
    amount: "",
    currency: "CHF",
    issueDate: "",
    dueDate: "",
    reference: "",
    referenceType: "",
    message: "",
    invoiceNumber: "",
    expectedAccountId: "",
    notes: "",
    taxYear: "",
  };
}

export function billToFormValues(bill: {
  kind: BillKind;
  creditorName: string | null;
  creditorIban: string | null;
  amount: Minor | null;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  reference: string | null;
  referenceType: BillReferenceType | null;
  message: string | null;
  invoiceNumber: string | null;
  expectedAccountId: string | null;
  notes: string | null;
  taxYear: number | null;
}): BillFormValues {
  return {
    kind: bill.kind,
    creditorName: bill.creditorName ?? "",
    creditorIban: bill.creditorIban ? formatIban(bill.creditorIban) : "",
    amount:
      bill.amount === null ? "" : minorToInput(bill.amount, bill.currency),
    currency: bill.currency,
    issueDate: bill.issueDate ?? "",
    dueDate: bill.dueDate ?? "",
    reference: bill.reference ? formatReference(bill.reference) : "",
    referenceType: bill.referenceType ?? "",
    message: bill.message ?? "",
    invoiceNumber: bill.invoiceNumber ?? "",
    expectedAccountId: bill.expectedAccountId ?? "",
    notes: bill.notes ?? "",
    taxYear: bill.taxYear === null ? "" : String(bill.taxYear),
  };
}

const PDF_KEYS = [
  "creditorName",
  "creditorIban",
  "amount",
  "issueDate",
  "dueDate",
  "reference",
  "referenceType",
  "message",
  "invoiceNumber",
] as const;

/**
 * Overlays the values read from a PDF onto the stored bill for review.
 * Only fields the PDF actually yielded replace stored ones; kind is never
 * changed, and currency only from a QR code (the text fallback defaults it)
 * and only while no payments are matched.
 */
export function mergeRereadDraft(
  base: BillFormValues,
  draft: Partial<BillFormValues>,
  opts: { source: "qr" | "text" | "none"; hasAllocations: boolean },
): BillFormValues {
  const out = { ...base };
  for (const key of PDF_KEYS) {
    const value = draft[key];
    if (value !== undefined && value !== "") {
      (out as Record<string, string>)[key] = value;
    }
  }
  if (out.creditorIban) out.creditorIban = formatIban(out.creditorIban);
  if (out.reference) out.reference = formatReference(out.reference);
  if (opts.source === "qr" && !opts.hasAllocations && draft.currency) {
    out.currency = draft.currency;
  }
  return out;
}
