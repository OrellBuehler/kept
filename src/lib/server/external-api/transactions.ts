import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
} from "drizzle-orm";
import { z } from "zod";
import type { Minor } from "$lib/money";
import {
  billAllocations,
  first,
  getDB,
  likeContains,
  transactions,
} from "$lib/server/db";
import {
  accountAllowed,
  transactionVisibility,
  type Visibility,
} from "$lib/server/ledger/visibility";
import {
  DEFAULT_LIMIT,
  ApiError,
  dateParam,
  decodeCursor,
  encodeCursor,
  iso,
  notFoundError,
  pagingQuery,
  type Page,
} from "./http";
import { transactionUrl } from "./urls";

export interface TransactionDto {
  id: string;
  accountId: string;
  bookingDate: string;
  /** Signed minor units of `currency`: outgoing is negative. */
  amount: Minor;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  categoryId: string | null;
  /** Bills this payment is allocated to. */
  billIds: string[];
  url: string;
  updatedAt: string;
}

/** What the MCP server shows on top of the REST shape: the owner's note (never IBANs or references). */
export interface TransactionDetailDto extends TransactionDto {
  note: string | null;
}

const MAX_SEARCH = 100;

const flag = z
  .enum(["true", "false"], "Use true or false.")
  .transform((v) => v === "true");

export const transactionsQuery = z.object({
  ...pagingQuery,
  from: dateParam.optional(),
  to: dateParam.optional(),
  categoryId: z.string().min(1).max(64).optional(),
  accountId: z.string().min(1).max(64).optional(),
  /** Only payments without a category (`true`) or with one (`false`). */
  uncategorized: flag.optional(),
  /** Only payments no bill is allocated to (`true`) or that are allocated to one (`false`). */
  unmatched: flag.optional(),
  q: z
    .string()
    .max(MAX_SEARCH)
    .transform((s) => s.trim())
    .optional(),
});
export type TransactionsQuery = z.output<typeof transactionsQuery>;

const columns = {
  id: transactions.id,
  accountId: transactions.accountId,
  bookingDate: transactions.bookingDate,
  seq: transactions.seq,
  amount: transactions.amount,
  currency: transactions.currency,
  counterpartyName: transactions.counterpartyName,
  description: transactions.description,
  reference: transactions.reference,
  note: transactions.note,
  categoryId: transactions.categoryId,
  updatedAt: transactions.updatedAt,
};

type Row = {
  id: string;
  accountId: string;
  bookingDate: string;
  amount: Minor;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  reference: string | null;
  note: string | null;
  categoryId: string | null;
  updatedAt: Date;
};

interface Allocated {
  billIds: string[];
  /** Latest change to one of the allocations (allocating does not touch the transaction row). */
  changedAt: Date | null;
}

async function allocatedBills(
  userId: string,
  ids: readonly string[],
): Promise<Map<string, Allocated>> {
  const out = new Map<string, Allocated>();
  if (ids.length === 0) return out;
  const rows = await getDB()
    .select({
      transactionId: billAllocations.transactionId,
      billId: billAllocations.billId,
      updatedAt: billAllocations.updatedAt,
    })
    .from(billAllocations)
    .where(
      and(
        eq(billAllocations.userId, userId),
        inArray(billAllocations.transactionId, [...ids]),
      ),
    )
    .orderBy(billAllocations.billId);
  for (const r of rows) {
    const entry = out.get(r.transactionId);
    if (!entry) {
      out.set(r.transactionId, { billIds: [r.billId], changedAt: r.updatedAt });
      continue;
    }
    entry.billIds.push(r.billId);
    if (!entry.changedAt || r.updatedAt > entry.changedAt) {
      entry.changedAt = r.updatedAt;
    }
  }
  return out;
}

function toDetail(
  r: Row,
  allocated: Allocated | undefined,
  origin: string,
): TransactionDetailDto {
  const updated = Math.max(
    r.updatedAt.getTime(),
    allocated?.changedAt?.getTime() ?? 0,
  );
  return {
    id: r.id,
    accountId: r.accountId,
    bookingDate: r.bookingDate,
    amount: r.amount,
    currency: r.currency,
    counterpartyName: r.counterpartyName,
    description: r.description,
    note: r.note,
    categoryId: r.categoryId,
    billIds: allocated?.billIds ?? [],
    url: transactionUrl(origin, r.accountId, r.id),
    updatedAt: iso(new Date(updated)),
  };
}

/**
 * Newest booking date first (then insertion order, then id). `visibility` is
 * the credential's restriction: only transactions inside it exist as far as
 * the credential is concerned.
 */
export async function listTransactionDetails(
  userId: string,
  visibility: Visibility,
  query: TransactionsQuery,
  origin: string,
): Promise<Page<TransactionDetailDto>> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const cursor = decodeCursor(query.cursor, 3);
  if (
    cursor &&
    (typeof cursor[0] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(cursor[0]) ||
      typeof cursor[1] !== "number" ||
      !Number.isSafeInteger(cursor[1]) ||
      cursor[1] < 0 ||
      typeof cursor[2] !== "string" ||
      cursor[2].length > 64)
  ) {
    throw new ApiError(400, "Invalid cursor.");
  }
  if (
    query.accountId !== undefined &&
    !accountAllowed(visibility, query.accountId)
  ) {
    return { items: [], nextCursor: null };
  }
  const db = getDB();
  const where = and(
    eq(transactions.userId, userId),
    transactionVisibility(visibility),
    query.uncategorized === true ? isNull(transactions.categoryId) : undefined,
    query.uncategorized === false
      ? isNotNull(transactions.categoryId)
      : undefined,
    query.unmatched === undefined
      ? undefined
      : (query.unmatched ? notExists : exists)(
          db
            .select({ id: billAllocations.id })
            .from(billAllocations)
            .where(
              and(
                eq(billAllocations.transactionId, transactions.id),
                eq(billAllocations.userId, userId),
              ),
            ),
        ),
    query.categoryId !== undefined
      ? eq(transactions.categoryId, query.categoryId)
      : undefined,
    query.accountId !== undefined
      ? eq(transactions.accountId, query.accountId)
      : undefined,
    query.from !== undefined
      ? gte(transactions.bookingDate, query.from)
      : undefined,
    query.to !== undefined
      ? lte(transactions.bookingDate, query.to)
      : undefined,
    query.updatedSince !== undefined
      ? or(
          gte(transactions.updatedAt, query.updatedSince),
          exists(
            getDB()
              .select({ id: billAllocations.id })
              .from(billAllocations)
              .where(
                and(
                  eq(billAllocations.transactionId, transactions.id),
                  eq(billAllocations.userId, userId),
                  gte(billAllocations.updatedAt, query.updatedSince),
                ),
              ),
          ),
        )
      : undefined,
    query.q
      ? or(
          likeContains(transactions.description, query.q),
          likeContains(transactions.counterpartyName, query.q),
        )
      : undefined,
    cursor
      ? or(
          lt(transactions.bookingDate, cursor[0] as string),
          and(
            eq(transactions.bookingDate, cursor[0] as string),
            lt(transactions.seq, cursor[1] as number),
          ),
          and(
            eq(transactions.bookingDate, cursor[0] as string),
            eq(transactions.seq, cursor[1] as number),
            lt(transactions.id, cursor[2] as string),
          ),
        )
      : undefined,
  );
  const rows = await getDB()
    .select(columns)
    .from(transactions)
    .where(where)
    .orderBy(
      desc(transactions.bookingDate),
      desc(transactions.seq),
      desc(transactions.id),
    )
    .limit(limit + 1);
  const slice = rows.slice(0, limit);
  const bills = await allocatedBills(
    userId,
    slice.map((r) => r.id),
  );
  const last = slice[slice.length - 1];
  return {
    items: slice.map((r) => toDetail(r, bills.get(r.id), origin)),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor([last.bookingDate, last.seq, last.id])
        : null,
  };
}

export async function getTransactionDetail(
  userId: string,
  visibility: Visibility,
  id: string,
  origin: string,
): Promise<TransactionDetailDto> {
  const row = await first(
    getDB()
      .select(columns)
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, id),
          transactionVisibility(visibility),
        ),
      )
      .limit(1),
  );
  if (!row) throw notFoundError("Transaction");
  const bills = await allocatedBills(userId, [row.id]);
  return toDetail(row, bills.get(row.id), origin);
}

/** The REST shape: without the owner's note. */
function publicShape({
  note: _note,
  ...dto
}: TransactionDetailDto): TransactionDto {
  return dto;
}

export async function listTransactionDtos(
  userId: string,
  visibility: Visibility,
  query: TransactionsQuery,
  origin: string,
): Promise<Page<TransactionDto>> {
  const page = await listTransactionDetails(userId, visibility, query, origin);
  return { items: page.items.map(publicShape), nextCursor: page.nextCursor };
}

export async function getTransactionDto(
  userId: string,
  visibility: Visibility,
  id: string,
  origin: string,
): Promise<TransactionDto> {
  return publicShape(
    await getTransactionDetail(userId, visibility, id, origin),
  );
}
