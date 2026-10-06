import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AccountType } from "$lib/ledger-types";
import type { CategoryKind } from "$lib/category-types";
import type { Minor } from "$lib/money";
import {
  SERIES_STATUSES,
  type Cadence,
  type SeriesStatus,
} from "$lib/recurring-types";
import { accounts, categories, getDB, recurringSeries } from "$lib/server/db";
import { listRecurring } from "$lib/server/recurring/series";
import { ApiError, iso, pageInMemory, pagingQuery, type Page } from "./http";

export interface CategoryDto {
  id: string;
  name: string;
  /** Null for a top-level category, and for a subcategory whose parent the token may not see. */
  parentId: string | null;
  kind: CategoryKind;
  color: string | null;
  updatedAt: string;
}

export interface AccountDto {
  id: string;
  name: string;
  currency: string;
  type: AccountType;
  archived: boolean;
  updatedAt: string;
}

export interface RecurringSeriesDto {
  id: string;
  status: SeriesStatus;
  name: string;
  cadence: Cadence;
  currency: string;
  /** Typical amount per occurrence, signed minor units: negative for payments. */
  amount: Minor;
  /** Signed cost per month (annual / 12, rounded). */
  monthlyCost: Minor;
  /** Signed cost per year. */
  annualCost: Minor;
  firstDate: string;
  lastDate: string;
  lastAmount: Minor;
  occurrences: number;
  /** The date after `lastDate` the next payment is expected. */
  nextExpected: string;
  /** The next payment is more than a week late. */
  overdue: boolean;
  updatedAt: string;
}

export const listQuery = z.object(pagingQuery);
export const recurringQuery = z.object({
  ...pagingQuery,
  status: z.enum(SERIES_STATUSES).optional(),
});

const since = (updatedAt: Date, updatedSince: Date | undefined) =>
  updatedSince === undefined || updatedAt >= updatedSince;

export async function listCategoryDtos(
  userId: string,
  allowed: readonly string[] | null,
  query: z.output<typeof listQuery>,
): Promise<Page<CategoryDto>> {
  if (allowed !== null && allowed.length === 0) {
    return { items: [], nextCursor: null };
  }
  const rows = await getDB()
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        allowed !== null ? inArray(categories.id, [...allowed]) : undefined,
      ),
    );
  const visible = new Set(rows.map((r) => r.id));
  const items = rows
    .filter((r) => since(r.updatedAt, query.updatedSince))
    .map((r): CategoryDto => ({
      id: r.id,
      name: r.name,
      parentId:
        r.parentId !== null && visible.has(r.parentId) ? r.parentId : null,
      kind: r.kind,
      color: r.color,
      updatedAt: iso(r.updatedAt),
    }));
  return pageInMemory(items, (c) => [c.name, c.id], {
    keyLength: 2,
    limit: query.limit,
    cursor: query.cursor,
  });
}

export async function listAccountDtos(
  userId: string,
  query: z.output<typeof listQuery>,
): Promise<Page<AccountDto>> {
  const rows = await getDB()
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      type: accounts.type,
      archived: accounts.archived,
      sortOrder: accounts.sortOrder,
      updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const withKey = rows
    .filter((r) => since(r.updatedAt, query.updatedSince))
    .map((r) => ({
      dto: {
        id: r.id,
        name: r.name,
        currency: r.currency,
        type: r.type,
        archived: r.archived,
        updatedAt: iso(r.updatedAt),
      } satisfies AccountDto,
      sortOrder: r.sortOrder,
    }));
  const page = pageInMemory(
    withKey,
    (a) => [a.sortOrder, a.dto.name, a.dto.id],
    { keyLength: 3, limit: query.limit, cursor: query.cursor },
  );
  return { items: page.items.map((a) => a.dto), nextCursor: page.nextCursor };
}

export async function listRecurringDtos(
  userId: string,
  allowed: readonly string[] | null,
  query: z.output<typeof recurringQuery>,
): Promise<Page<RecurringSeriesDto>> {
  // Series are detected across every category, so a category-restricted token may not read them.
  if (allowed !== null) {
    throw new ApiError(
      403,
      "Recurring series are not available to tokens limited to categories.",
    );
  }
  const [views, times] = await Promise.all([
    listRecurring(userId),
    getDB()
      .select({ id: recurringSeries.id, updatedAt: recurringSeries.updatedAt })
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, userId)),
  ]);
  const updated = new Map(times.map((t) => [t.id, t.updatedAt]));
  const items = views
    .filter((v) => query.status === undefined || v.status === query.status)
    .flatMap((v): RecurringSeriesDto[] => {
      const updatedAt = updated.get(v.id);
      if (!updatedAt || !since(updatedAt, query.updatedSince)) return [];
      return [
        {
          id: v.id,
          status: v.status,
          name: v.name,
          cadence: v.cadence,
          currency: v.currency,
          amount: v.amount,
          monthlyCost: v.monthlyCost,
          annualCost: v.annualCost,
          firstDate: v.firstDate,
          lastDate: v.lastDate,
          lastAmount: v.lastAmount,
          occurrences: v.occurrences,
          nextExpected: v.nextExpected,
          overdue: v.overdue,
          updatedAt: iso(updatedAt),
        },
      ];
    });
  return pageInMemory(items, (s) => [s.nextExpected, s.name, s.id], {
    keyLength: 3,
    limit: query.limit,
    cursor: query.cursor,
  });
}
