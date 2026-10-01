import { z } from "zod";
import {
  BILL_KINDS,
  BILL_REFERENCE_TYPES,
  type BillKind,
  type BillReferenceType,
} from "$lib/bill-types";
import { isQrIban, normalizeIban } from "$lib/iban";
import { type Minor } from "$lib/money";
import {
  currencySchema,
  idSchema,
  optionalDate,
  optionalIban,
  optionalOf,
  optionalText,
  parseMoneyInput,
} from "$lib/server/ledger/schemas";
import { isValidQrr, isValidScor, normalizeReference } from "$lib/references";

/** Largest accepted amount in minor units (keeps sums well inside safe integers). */
export const MAX_BILL_AMOUNT = 1_000_000_000_000;

export interface BillInput {
  kind: BillKind;
  creditorName: string | null;
  creditorIban: string | null;
  /** Minor units, > 0; null is an open-amount bill. */
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
}

export const BILL_FORM_FIELDS = [
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
] as const;

const kindField = z.preprocess(
  (v) => (v === undefined || v === "" ? "invoice" : v),
  z.enum(BILL_KINDS, "Choose invoice or credit note."),
);

const billFormSchema = z.object({
  kind: kindField,
  creditorName: optionalText(140, "Creditor"),
  creditorIban: optionalIban,
  amount: z.string().optional(),
  currency: currencySchema,
  issueDate: optionalDate,
  dueDate: optionalDate,
  reference: optionalText(35, "Reference"),
  referenceType: optionalOf(
    z.enum(BILL_REFERENCE_TYPES, "Choose QRR, SCOR or NON."),
  ),
  message: optionalText(500, "Message"),
  invoiceNumber: optionalText(100, "Invoice number"),
  expectedAccountId: optionalOf(idSchema),
  notes: optionalText(2000, "Notes"),
  taxYear: optionalOf(
    z
      .string()
      .trim()
      .regex(/^\d{4}$/, "Enter a four-digit year.")
      .transform(Number)
      .refine(
        (y) => y >= 1900 && y <= 2200,
        "Enter a year between 1900 and 2200.",
      ),
  ),
});

function inferReferenceType(reference: string): BillReferenceType | null {
  if (/^\d{27}$/.test(reference)) return "QRR";
  if (/^RF/.test(reference)) return "SCOR";
  return null;
}

export const billInputSchema = billFormSchema.transform((v, ctx): BillInput => {
  const issue = (path: string, message: string) =>
    ctx.issues.push({ code: "custom", message, input: v, path: [path] });

  if (v.creditorName === null && v.creditorIban === null) {
    issue("creditorName", "Enter a creditor name or an IBAN.");
  }

  let amount: Minor | null = null;
  const rawAmount = v.amount?.trim() ?? "";
  if (rawAmount !== "") {
    const r = parseMoneyInput(rawAmount, v.currency);
    if (!r.ok) issue("amount", r.message);
    else if (r.value <= 0) {
      issue(
        "amount",
        "Amount must be greater than zero. Leave it empty for an open amount.",
      );
    } else if (r.value > MAX_BILL_AMOUNT) {
      issue("amount", "Amount is too large.");
    } else amount = r.value;
  }

  if (v.issueDate && v.dueDate && v.dueDate < v.issueDate) {
    issue("dueDate", "The due date cannot be before the issue date.");
  }

  let reference: string | null = null;
  let referenceType = v.referenceType;
  if (v.reference !== null) {
    reference = normalizeReference(v.reference);
    referenceType ??= inferReferenceType(reference);
    if (referenceType === null) {
      issue(
        "reference",
        "Enter a QR reference (27 digits) or a creditor reference (RF…).",
      );
    } else if (referenceType === "NON") {
      issue(
        "reference",
        "Remove the reference or choose the QRR or SCOR type.",
      );
    } else if (referenceType === "QRR" && !isValidQrr(reference)) {
      issue(
        "reference",
        "Not a valid QR reference (27 digits with a check digit).",
      );
    } else if (referenceType === "SCOR" && !isValidScor(reference)) {
      issue("reference", "Not a valid creditor reference (RF…).");
    }
  } else if (referenceType === "QRR" || referenceType === "SCOR") {
    issue("reference", "Enter the reference or clear the reference type.");
  }

  if (v.creditorIban !== null) {
    const qrIban = isQrIban(v.creditorIban);
    if (qrIban && referenceType !== "QRR") {
      issue("reference", "A QR-IBAN requires a QR reference (QRR).");
    } else if (!qrIban && referenceType === "QRR") {
      issue("referenceType", "A QR reference (QRR) requires a QR-IBAN.");
    }
  }

  return {
    kind: v.kind,
    creditorName: v.creditorName,
    creditorIban:
      v.creditorIban === null ? null : normalizeIban(v.creditorIban),
    amount,
    currency: v.currency,
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    reference,
    referenceType,
    message: v.message,
    invoiceNumber: v.invoiceNumber,
    expectedAccountId: v.expectedAccountId,
    notes: v.notes,
    taxYear: v.taxYear,
  };
});

/** Optional attachment reference accepted by the create form. */
export const optionalDocumentIdSchema = z.object({
  documentId: optionalOf(idSchema),
});

export const allocateFormSchema = z.object({
  transactionId: idSchema,
  amount: z.string().trim().min(1, "Enter an amount."),
});

export const confirmFormSchema = z.object({
  billId: idSchema,
  transactionId: idSchema,
  amount: z.string().trim().min(1, "Enter an amount."),
});

export const dismissFormSchema = z.object({
  billId: idSchema,
  transactionId: idSchema,
});

export const dismissForBillFormSchema = z.object({
  transactionId: idSchema,
});

export const removeAllocationFormSchema = z.object({
  allocationId: idSchema,
});
