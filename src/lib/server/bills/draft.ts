import { currencyExponent, toDecimalString } from "$lib/money";
import type { PdfExtractErrorCode } from "./pdf-extract";
import type { BillExtraction } from "./pdf-extract";

/** Form values (all strings) proposed from an extraction. Never saved automatically. */
export interface BillDraft {
  kind: "invoice" | "credit_note";
  creditorName: string;
  creditorIban: string;
  /** Decimal string, "" for an open amount. */
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  reference: string;
  referenceType: "QRR" | "SCOR" | "NON" | "";
  message: string;
  invoiceNumber: string;
}

export interface DraftResult {
  draft: BillDraft;
  warnings: string[];
}

export function billFromExtraction(extraction: BillExtraction): DraftResult {
  const f = extraction.fields;
  const warnings = [...extraction.warnings];
  const currency = f.currency ?? "CHF";
  let amount = "";
  if (f.amount !== null) {
    if (f.amount > 0) {
      amount = toDecimalString(f.amount, currencyExponent(currency));
    } else {
      warnings.push(
        "The bill has an amount of zero (notification only). Enter the amount to pay or leave it empty for an open amount.",
      );
    }
  }
  return {
    draft: {
      kind: "invoice",
      creditorName: f.creditorName ?? "",
      creditorIban: f.creditorIban ?? "",
      amount,
      currency,
      issueDate: extraction.qr?.invoiceDate ?? "",
      dueDate: f.dueDate ?? "",
      reference: f.reference ?? "",
      referenceType: f.referenceType ?? "",
      message: extraction.qr?.message ?? "",
      invoiceNumber: f.invoiceNumber ?? "",
    },
    warnings,
  };
}

export function pdfErrorMessage(code: PdfExtractErrorCode): string {
  switch (code) {
    case "too_large":
      return "The PDF is larger than 20 MB.";
    case "not_pdf":
      return "That file is not a PDF.";
    case "encrypted":
      return "The PDF is password protected. Remove the password and upload it again.";
    case "too_many_pages":
      return "The PDF has too many pages (limit 200).";
    case "unreadable":
      return "The PDF could not be read.";
  }
}
