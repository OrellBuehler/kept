import { z } from "zod";
import { parseAmount, type Minor } from "$lib/money";
import type { BillWithStatus } from "./status";

export const BILL_LIST_STATUSES = [
  "all",
  "open",
  "overdue",
  "paid",
  "refund",
  "cancelled",
] as const;
export type BillListStatus = (typeof BILL_LIST_STATUSES)[number];

export const BILL_LIST_PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 200;

export interface BillListQuery {
  q: string;
  status: BillListStatus;
  page: number;
}

export const billListQuerySchema = z.object({
  q: z
    .string()
    .catch("")
    .transform((s) => s.trim().slice(0, MAX_QUERY_LENGTH).trim()),
  status: z.enum(BILL_LIST_STATUSES).catch("all"),
  page: z
    .string()
    .regex(/^\d{1,6}$/)
    .transform((s) => Math.max(1, Number(s)))
    .catch(1),
});

export function parseBillListQuery(
  searchParams: URLSearchParams,
): BillListQuery {
  return billListQuerySchema.parse({
    q: searchParams.get("q") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    page: searchParams.get("page") ?? undefined,
  });
}

function matchesStatus(v: BillWithStatus, status: BillListStatus): boolean {
  switch (status) {
    case "all":
      return true;
    case "open":
      return (
        (v.status === "open" || v.status === "partially_paid") && !v.overdue
      );
    case "overdue":
      return v.overdue;
    case "paid":
      return v.status === "paid";
    case "refund":
      return (
        v.status === "credit_due" ||
        (v.status === "overpaid" && v.kind === "invoice")
      );
    case "cancelled":
      return v.status === "cancelled";
  }
}

const stripSpaces = (s: string) => s.replace(/\s+/g, "").toLowerCase();

// Shorter fragments such as "ch" or "rf" would match almost every IBAN or reference.
const MIN_COMPACT_MATCH = 4;

function parseQueryAmount(q: string): Minor | null {
  try {
    return parseAmount(q);
  } catch (err) {
    // Free text is not an amount; anything else is a bug.
    if (err instanceof SyntaxError || err instanceof RangeError) return null;
    throw err;
  }
}

function sortKey(v: BillWithStatus): string | null {
  return v.dueDate ?? v.issueDate;
}

function bySortKey(a: BillWithStatus, b: BillWithStatus): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka < kb ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function filterBills(
  views: readonly BillWithStatus[],
  { q, status }: { q: string; status: BillListStatus },
): BillWithStatus[] {
  const text = q.trim().toLowerCase();
  const compact = stripSpaces(q);
  const amount = text ? parseQueryAmount(text) : null;
  const matchesText = (v: BillWithStatus): boolean => {
    if (!text) return true;
    if (amount !== null && v.amount === amount) return true;
    for (const field of [v.creditorName, v.invoiceNumber, v.message, v.notes]) {
      if (field && field.toLowerCase().includes(text)) return true;
    }
    if (compact.length >= MIN_COMPACT_MATCH) {
      for (const field of [v.reference, v.creditorIban]) {
        if (field && stripSpaces(field).includes(compact)) return true;
      }
    }
    return false;
  };
  return views
    .filter((v) => matchesStatus(v, status) && matchesText(v))
    .sort(bySortKey);
}

export interface BillPage {
  items: BillWithStatus[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function paginateBills(
  list: readonly BillWithStatus[],
  page: number,
  pageSize = BILL_LIST_PAGE_SIZE,
): BillPage {
  const size = Math.max(1, Math.floor(pageSize));
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  return {
    items: list.slice((current - 1) * size, current * size),
    total,
    page: current,
    pageSize: size,
    pageCount,
  };
}
