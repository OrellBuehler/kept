import type { Minor } from "$lib/money";
import { accounts, transactions } from "$lib/server/db";

/** The transaction fields the bill screens show. */
export interface TransactionDisplay {
  id: string;
  accountId: string;
  accountName: string;
  bookingDate: string;
  /** Signed from the account holder's view: outgoing is negative. */
  amount: Minor;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  reference: string | null;
}

export const transactionDisplayColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  accountName: accounts.name,
  bookingDate: transactions.bookingDate,
  amount: transactions.amount,
  currency: transactions.currency,
  counterpartyName: transactions.counterpartyName,
  description: transactions.description,
  reference: transactions.reference,
};
