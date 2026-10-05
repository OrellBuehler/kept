import { and, count, desc, eq, gte, lte, or } from "drizzle-orm";
import type { RowSource } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  first,
  getDB,
  likeContains,
  transactions,
  type DB,
  transaction,
} from "$lib/server/db";
import {
  mirrorRefs,
  transferRefs,
  type MirrorRef,
  type TransferRef,
} from "$lib/server/transfers/view";
import { linkAfterWrite } from "$lib/server/transfers/link";
import { unlink } from "$lib/server/transfers/manual";
import {
  findReplacementsInTx,
  takeOverMirror,
} from "$lib/server/transfers/replace";
import { resyncSource } from "$lib/server/transfers/sync";
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
  deductionYear: number | null;
  createdAt: number;
  /** Mirrors only: the transaction on another account this row was created from. */
  mirrorOf: MirrorRef | null;
  /** The transfer between two of the user's accounts this row belongs to (not when dismissed). */
  transfer: TransferRef | null;
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
  deductionYear: transactions.deductionYear,
  createdAt: transactions.createdAt,
  mirrorOfId: transactions.mirrorOfId,
};

type Row = Omit<TransactionView, "mirrorOf" | "transfer"> & {
  mirrorOfId: string | null;
};

/** What `columns` selects: the creation time is a Date on every database. */
type SelectedRow = Omit<Row, "createdAt"> & { createdAt: Date };

function toRow({ createdAt, ...rest }: SelectedRow): Row {
  return { ...rest, createdAt: createdAt.getTime() };
}

async function decorate(
  userId: string,
  rows: readonly Row[],
): Promise<TransactionView[]> {
  const transfer = await transferRefs(
    userId,
    rows.map((r) => r.id),
  );
  const mirrors = await mirrorRefs(
    userId,
    rows.filter((r) => r.source === "mirror"),
  );
  return rows.map(({ mirrorOfId: _mirrorOfId, ...r }) => ({
    ...r,
    mirrorOf: mirrors.get(r.id) ?? null,
    transfer: transfer.get(r.id) ?? null,
  }));
}

function ownedAccountQuery(
  conn: Pick<DB, "select">,
  userId: string,
  accountId: string,
) {
  return conn
    .select({ currency: accounts.currency, openingDate: accounts.openingDate })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .limit(1);
}

async function ownedAccount(userId: string, accountId: string) {
  const account = await first(ownedAccountQuery(getDB(), userId, accountId));
  if (!account) throw notFound("Account");
  return account;
}

/** `ownedAccount` on a transaction you already hold. */
async function ownedAccountInTx(
  tx: Pick<DB, "select">,
  userId: string,
  accountId: string,
) {
  const account = await first(ownedAccountQuery(tx, userId, accountId));
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

/** Newest first. Text search is case-insensitive (ASCII only on SQLite, Unicode on PostgreSQL) over description, counterparty and note. */
export async function listTransactions(
  userId: string,
  accountId: string,
  opts: { filters?: TransactionFilters; page?: number; pageSize?: number } = {},
): Promise<TransactionPage> {
  await ownedAccount(userId, accountId);
  const f = opts.filters ?? {};
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 50));
  const requested = Math.max(1, Math.floor(opts.page ?? 1));

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
    f.q
      ? or(
          likeContains(transactions.description, f.q),
          likeContains(transactions.counterpartyName, f.q),
          likeContains(transactions.note, f.q),
        )
      : undefined,
  );

  const db = getDB();
  const total = (await first(
    db.select({ n: count() }).from(transactions).where(where).limit(1),
  ))!.n;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pageCount);
  const items = await decorate(
    userId,
    (
      await db
        .select(columns)
        .from(transactions)
        .where(where)
        .orderBy(
          desc(transactions.bookingDate),
          desc(transactions.seq),
          desc(transactions.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize)
    ).map(toRow),
  );
  return { items, total, page, pageSize, pageCount };
}

function ownedTransactionQuery(
  conn: Pick<DB, "select">,
  userId: string,
  id: string,
) {
  return conn
    .select(columns)
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .limit(1);
}

export async function getTransaction(
  userId: string,
  id: string,
): Promise<TransactionView> {
  const row = await first(ownedTransactionQuery(getDB(), userId, id));
  if (!row) throw notFound("Transaction");
  return (await decorate(userId, [toRow(row)]))[0]!;
}

/**
 * `getTransaction` on a transaction you already hold. It returns the
 * plain row, without the transfer and mirror references `getTransaction` adds.
 */
export async function getTransactionRowInTx(
  tx: Pick<DB, "select">,
  userId: string,
  id: string,
): Promise<Row> {
  const row = await first(ownedTransactionQuery(tx, userId, id));
  if (!row) throw notFound("Transaction");
  return toRow(row);
}

export async function createManualTransaction(
  userId: string,
  accountId: string,
  input: TransactionInput,
): Promise<TransactionView> {
  const id = await transaction(async (tx) => {
    const { currency, openingDate } = await ownedAccountInTx(
      tx,
      userId,
      accountId,
    );
    assertNotBeforeOpening({ openingDate }, input.bookingDate);
    const created = (await first(
      tx
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
        .returning({ id: transactions.id }),
    ))!;
    // Like an imported row, a manual one takes over the mirror it stands for.
    const mirrorId = (
      await findReplacementsInTx(tx, userId, accountId, [
        {
          key: created.id,
          bookingDate: input.bookingDate,
          amount: input.amount,
          counterpartyIban: input.counterpartyIban,
          reference: input.reference,
          description: input.description,
        },
      ])
    ).get(created.id);
    if (mirrorId !== undefined)
      await takeOverMirror(tx, userId, mirrorId, created.id);
    await linkAfterWrite(
      tx,
      userId,
      accountId,
      [created.id],
      [input.bookingDate],
    );
    return created.id;
  });
  return await getTransaction(userId, id);
}

/** Manual rows take all fields; imported rows and mirrors only accept a note. */
export async function updateTransaction(
  userId: string,
  id: string,
  input: TransactionInput | TransactionNoteInput,
): Promise<TransactionView> {
  const current = await getTransaction(userId, id);
  const where = and(eq(transactions.userId, userId), eq(transactions.id, id));
  if (current.source !== "manual") {
    await getDB().update(transactions).set({ note: input.note }).where(where);
  } else {
    if (!("bookingDate" in input)) {
      throw new LedgerError("invalid", "Missing transaction fields.");
    }
    await transaction(async (tx) => {
      // Read again inside the transaction: the previous IBAN decides which links survive.
      const previous = await getTransactionRowInTx(tx, userId, id);
      assertNotBeforeOpening(
        await ownedAccountInTx(tx, userId, previous.accountId),
        input.bookingDate,
      );
      await tx.update(transactions).set(input).where(where);
      // A mirror follows its source's amount, dates and text.
      await resyncSource(tx, userId, id, previous.counterpartyIban);
    });
  }
  return await getTransaction(userId, id);
}

export async function deleteTransaction(
  userId: string,
  id: string,
): Promise<void> {
  const current = await getTransaction(userId, id);
  if (current.source === "mirror") {
    // Deleting a mirror means "this is not a transfer": the unlink remembers it.
    // One that lost its transfer has nothing to remember and just goes.
    if (current.transfer) {
      await unlink(userId, current.transfer.id);
    } else {
      await getDB()
        .delete(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
    }
    return;
  }
  if (current.source !== "manual") {
    throw new LedgerError(
      "conflict",
      "Imported transactions cannot be deleted. Delete the import instead.",
    );
  }
  await getDB()
    .delete(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)));
}
