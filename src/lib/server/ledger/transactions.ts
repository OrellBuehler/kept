import { and, count, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import type { RowSource } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import { accounts, getDB, transactions } from "$lib/server/db";
import { LedgerError, notFound } from "./errors";
import type {
  TransactionFilters,
  TransactionInput,
  TransactionNoteInput,
} from "./schemas";

export interface TransactionView {
  id: string;
  accountId: string;
  importId: string | null;
  source: RowSource;
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
  referenceType: "QRR" | "SCOR" | null;
  reversal: boolean;
  note: string | null;
  categoryId: string | null;
  taxYear: number | null;
  createdAt: number;
}

export interface TransactionPage {
  items: TransactionView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const columns = {
  id: transactions.id,
  accountId: transactions.accountId,
  importId: transactions.importId,
  source: transactions.source,
  externalId: transactions.externalId,
  bookingDate: transactions.bookingDate,
  valueDate: transactions.valueDate,
  amount: transactions.amount,
  currency: transactions.currency,
  originalAmount: transactions.originalAmount,
  originalCurrency: transactions.originalCurrency,
  counterpartyName: transactions.counterpartyName,
  counterpartyIban: transactions.counterpartyIban,
  description: transactions.description,
  reference: transactions.reference,
  referenceType: transactions.referenceType,
  reversal: transactions.reversal,
  note: transactions.note,
  categoryId: transactions.categoryId,
  taxYear: transactions.taxYear,
  createdAt: sql<number>`${transactions.createdAt}`,
};

function ownedAccount(userId: string, accountId: string) {
  const account = getDB()
    .select({ currency: accounts.currency, openingDate: accounts.openingDate })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!account) throw notFound("Account");
  return account;
}

function assertNotBeforeOpening(
  account: { openingDate: string | null },
  bookingDate: string,
) {
  if (account.openingDate !== null && bookingDate < account.openingDate) {
    throw new LedgerError(
      "invalid",
      `The booking date cannot be before the account's opening date (${account.openingDate}).`,
      "bookingDate",
    );
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Newest first. Text search is case-insensitive (ASCII) over description, counterparty and note. */
export function listTransactions(
  userId: string,
  accountId: string,
  opts: { filters?: TransactionFilters; page?: number; pageSize?: number } = {},
): TransactionPage {
  ownedAccount(userId, accountId);
  const f = opts.filters ?? {};
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 50));
  const requested = Math.max(1, Math.floor(opts.page ?? 1));

  const pattern = f.q ? `%${escapeLike(f.q)}%` : null;
  const where = and(
    eq(transactions.userId, userId),
    eq(transactions.accountId, accountId),
    f.from ? gte(transactions.bookingDate, f.from) : undefined,
    f.to ? lte(transactions.bookingDate, f.to) : undefined,
    f.minAmount !== undefined
      ? gte(transactions.amount, f.minAmount)
      : undefined,
    f.maxAmount !== undefined
      ? lte(transactions.amount, f.maxAmount)
      : undefined,
    pattern
      ? or(
          sql`${transactions.description} like ${pattern} escape '\\'`,
          sql`${transactions.counterpartyName} like ${pattern} escape '\\'`,
          sql`${transactions.note} like ${pattern} escape '\\'`,
        )
      : undefined,
  );

  const db = getDB();
  const total = db.select({ n: count() }).from(transactions).where(where).get()!
    .n;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pageCount);
  const items = db
    .select(columns)
    .from(transactions)
    .where(where)
    .orderBy(desc(transactions.bookingDate), desc(sql`"transactions"."rowid"`))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  return { items, total, page, pageSize, pageCount };
}

export function getTransaction(userId: string, id: string): TransactionView {
  const row = getDB()
    .select(columns)
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .get();
  if (!row) throw notFound("Transaction");
  return row;
}

export function createManualTransaction(
  userId: string,
  accountId: string,
  input: TransactionInput,
): TransactionView {
  const { currency, openingDate } = ownedAccount(userId, accountId);
  assertNotBeforeOpening({ openingDate }, input.bookingDate);
  const row = getDB()
    .insert(transactions)
    .values({
      ...input,
      userId,
      accountId,
      currency,
      source: "manual",
      externalId: `manual:${crypto.randomUUID()}`,
      reversal: false,
    })
    .returning({ id: transactions.id })
    .get();
  return getTransaction(userId, row.id);
}

/** Manual rows take all fields; imported rows only accept a note. */
export function updateTransaction(
  userId: string,
  id: string,
  input: TransactionInput | TransactionNoteInput,
): TransactionView {
  const current = getTransaction(userId, id);
  const where = and(eq(transactions.userId, userId), eq(transactions.id, id));
  if (current.source === "import") {
    getDB().update(transactions).set({ note: input.note }).where(where).run();
  } else {
    if (!("bookingDate" in input)) {
      throw new LedgerError("invalid", "Missing transaction fields.");
    }
    assertNotBeforeOpening(
      ownedAccount(userId, current.accountId),
      input.bookingDate,
    );
    getDB().update(transactions).set(input).where(where).run();
  }
  return getTransaction(userId, id);
}

export function deleteTransaction(userId: string, id: string): void {
  const current = getTransaction(userId, id);
  if (current.source !== "manual") {
    throw new LedgerError(
      "conflict",
      "Imported transactions cannot be deleted. Delete the import instead.",
    );
  }
  getDB()
    .delete(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .run();
}
