import type { Minor } from "$lib/money";

export type ReferenceType = "QRR" | "SCOR";

export interface NormalizedTransaction {
  externalId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: Minor;
  currency: string;
  originalAmount: Minor | null;
  originalCurrency: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
  reference: string | null;
  referenceType: ReferenceType | null;
  reversal: boolean;
}

export interface NormalizedBalance {
  amount: Minor;
  currency: string;
  date: string;
}

export interface NormalizedStatement {
  accountIban: string | null;
  accountOtherId: string | null;
  currency: string;
  statementId: string | null;
  fromDate: string | null;
  toDate: string | null;
  openingBalance: NormalizedBalance | null;
  closingBalance: NormalizedBalance | null;
  transactions: NormalizedTransaction[];
}

export class ImportFormatError extends Error {
  override name = "ImportFormatError";
}
