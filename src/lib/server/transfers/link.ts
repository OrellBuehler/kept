import { and, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { normalizeIban } from "$lib/iban";
import { minor } from "$lib/money";
import {
  accounts,
  getDB,
  portfolios,
  transactions,
  transfers,
  type DB,
} from "$lib/server/db";
import {
  LINK_WINDOW_DAYS,
  accountsByIban,
  planLinks,
  shiftDate,
  type PlanAccount,
  type PlanTransaction,
  type PlannedLink,
} from "./plan";

/** A database or a transaction on it. */
export type Conn = Pick<DB, "select" | "insert" | "update" | "delete">;

const CHUNK = 500;

export function loadPlanAccounts(userId: string, conn: Conn): PlanAccount[] {
  const withPortfolios = new Set(
    conn
      .select({ id: portfolios.accountId })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .all()
      .map((r) => r.id),
  );
  return conn
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      type: accounts.type,
      iban: accounts.iban,
      openingDate: accounts.openingDate,
      fillFromTransfers: accounts.fillFromTransfers,
      archived: accounts.archived,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all()
    .map((a) => ({
      ...a,
      iban: a.iban ? normalizeIban(a.iban) : null,
      hasPortfolios: withPortfolios.has(a.id),
    }));
}

/**
 * Normalized IBAN -> account id for the user's accounts, archived ones
 * included. Only `iban` counts: a deposit IBAN (a QR-IBAN) is shared by many
 * customers, and pillar 3a payments are recognised by their reference.
 */
export function ownIbans(
  userId: string,
  conn: Conn = getDB(),
): Map<string, string> {
  return new Map(
    [...accountsByIban(loadPlanAccounts(userId, conn))].map(([iban, a]) => [
      iban,
      a.id,
    ]),
  );
}

const planColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  source: transactions.source,
  bookingDate: transactions.bookingDate,
  valueDate: transactions.valueDate,
  amount: transactions.amount,
  currency: transactions.currency,
  originalAmount: transactions.originalAmount,
  originalCurrency: transactions.originalCurrency,
  counterpartyIban: transactions.counterpartyIban,
  description: transactions.description,
  reference: transactions.reference,
  referenceType: transactions.referenceType,
};

/**
 * Ids of transactions that appear in a transfers row of the user: `taken`
 * for linked and dismissed rows, `pending` for rows that wait for an amount
 * (those may still pair with a real counterpart).
 */
export function transferClaims(
  userId: string,
  conn: Conn,
): { taken: Set<string>; pending: Set<string> } {
  const taken = new Set<string>();
  const pending = new Set<string>();
  for (const r of conn
    .select({
      out: transfers.outTransactionId,
      in: transfers.inTransactionId,
      status: transfers.status,
    })
    .from(transfers)
    .where(eq(transfers.userId, userId))
    .all()) {
    const into = r.status === "needs_amount" ? pending : taken;
    if (r.out) into.add(r.out);
    if (r.in) into.add(r.in);
  }
  return { taken, pending };
}

export interface LinkScope {
  /** Rows to look at as sources. */
  transactionIds?: readonly string[];
  /** Every row of this account is looked at as a source. */
  sourceAccountId?: string;
  /** Every row, on any account, that names this account's IBAN is looked at as a source. */
  targetAccountId?: string;
  /** Booking-date bounds for the sources, inclusive. */
  from?: string;
  to?: string;
}

export interface LinkResult {
  /** Existing rows on both sides, now linked. */
  paired: number;
  /** Counter-transactions created. */
  mirrored: number;
  /** FX transfers waiting for the received amount. */
  needsAmount: number;
}

const NONE: LinkResult = { paired: 0, mirrored: 0, needsAmount: 0 };

function loadSources(
  userId: string,
  scope: LinkScope,
  accountList: readonly PlanAccount[],
  conn: Conn,
): PlanTransaction[] {
  const base = [
    eq(transactions.userId, userId),
    ne(transactions.source, "mirror"),
    sql`${transactions.counterpartyIban} is not null`,
    scope.from ? gte(transactions.bookingDate, scope.from) : undefined,
    scope.to ? lte(transactions.bookingDate, scope.to) : undefined,
  ];
  const pick = (extra: ReturnType<typeof eq> | undefined) =>
    conn
      .select(planColumns)
      .from(transactions)
      .where(and(...base, extra))
      .all();

  const scoped =
    scope.transactionIds !== undefined ||
    scope.sourceAccountId !== undefined ||
    scope.targetAccountId !== undefined;
  const found = new Map<string, PlanTransaction>();
  const add = (rows: PlanTransaction[]) => {
    for (const r of rows) found.set(r.id, r);
  };
  if (!scoped) add(pick(undefined));
  if (scope.transactionIds) {
    for (let i = 0; i < scope.transactionIds.length; i += CHUNK) {
      add(
        pick(
          inArray(
            transactions.id,
            scope.transactionIds.slice(i, i + CHUNK) as string[],
          ),
        ),
      );
    }
  }
  if (scope.sourceAccountId !== undefined) {
    add(pick(eq(transactions.accountId, scope.sourceAccountId)));
  }
  if (scope.targetAccountId !== undefined) {
    const iban = accountList.find((a) => a.id === scope.targetAccountId)?.iban;
    if (iban) {
      add(
        pick(
          sql`upper(replace(${transactions.counterpartyIban}, ' ', '')) = ${iban}`,
        ),
      );
    }
  }
  return [...found.values()];
}

function loadCandidates(
  userId: string,
  sources: readonly PlanTransaction[],
  accountList: readonly PlanAccount[],
  conn: Conn,
): PlanTransaction[] {
  const byIban = accountsByIban(accountList);
  const targetIds = new Set<string>();
  let first = "9999-12-31";
  let last = "0000-01-01";
  for (const s of sources) {
    const target = byIban.get(normalizeIban(s.counterpartyIban!));
    if (!target) continue;
    targetIds.add(target.id);
    if (s.bookingDate < first) first = s.bookingDate;
    if (s.bookingDate > last) last = s.bookingDate;
  }
  if (targetIds.size === 0) return [];
  return conn
    .select(planColumns)
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        ne(transactions.source, "mirror"),
        inArray(transactions.accountId, [...targetIds]),
        gte(transactions.bookingDate, shiftDate(first, -LINK_WINDOW_DAYS)),
        lte(transactions.bookingDate, shiftDate(last, LINK_WINDOW_DAYS)),
      ),
    )
    .all();
}

/** Deletes the needs-amount rows of these transactions: their counter-side exists now. */
function dropWaiting(userId: string, ids: readonly string[], conn: Conn): void {
  conn
    .delete(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        eq(transfers.status, "needs_amount"),
        or(
          inArray(transfers.outTransactionId, ids as string[]),
          inArray(transfers.inTransactionId, ids as string[]),
        ),
      ),
    )
    .run();
}

function apply(userId: string, link: PlannedLink, conn: Conn): void {
  if (link.kind === "pair") {
    dropWaiting(userId, [link.sourceId, link.candidateId], conn);
  } else if (link.kind === "mirror") {
    dropWaiting(userId, [link.sourceId], conn);
  }
  let outId = link.outTransactionId;
  let inId = link.inTransactionId;
  let status: "linked" | "needs_amount" = "linked";
  let method: "paired" | "mirrored" = "paired";
  if (link.kind === "mirror") {
    method = "mirrored";
    const m = link.mirror;
    const externalId = `mirror:${link.sourceId}`;
    const created = conn
      .insert(transactions)
      .values({
        userId,
        accountId: m.accountId,
        importId: null,
        source: "mirror",
        externalId,
        mirrorOfId: link.sourceId,
        bookingDate: m.bookingDate,
        valueDate: m.valueDate,
        amount: minor(m.amount),
        currency: m.currency,
        counterpartyName: m.counterpartyName,
        counterpartyIban: m.counterpartyIban,
        description: m.description,
        reference: m.reference,
        referenceType: m.referenceType,
        reversal: false,
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
      })
      .returning({ id: transactions.id })
      .get();
    const mirrorId =
      created?.id ??
      conn
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, m.accountId),
            eq(transactions.externalId, externalId),
          ),
        )
        .get()!.id;
    if (outId === null) outId = mirrorId;
    else inId = mirrorId;
  } else if (link.kind === "needs_amount") {
    status = "needs_amount";
    method = "mirrored";
  }
  conn
    .insert(transfers)
    .values({
      userId,
      outTransactionId: outId,
      inTransactionId: inId,
      status,
      method,
      fromAccountId: link.fromAccountId,
      toAccountId: link.toAccountId,
    })
    .run();
}

/**
 * Looks at the rows selected by `scope` (all of the user's rows without a
 * scope) and links the transfers between the user's own accounts: pairs the
 * two booked sides, or mirrors the missing one onto an account that is filled
 * from transfers (see `planLinks`). Rows that already have a transfers row,
 * dismissed ones included, are left alone; a row waiting for an amount pairs
 * with its real counterpart once that shows up. Pass `conn` to run inside a
 * transaction you already hold; otherwise one is opened.
 */
export function linkTransfers(
  userId: string,
  scope: LinkScope = {},
  conn?: Conn,
): LinkResult {
  if (!conn) {
    return getDB().transaction((tx) => linkTransfers(userId, scope, tx));
  }
  const accountList = loadPlanAccounts(userId, conn);
  const sources = loadSources(userId, scope, accountList, conn);
  if (sources.length === 0) return { ...NONE };
  const { taken, pending } = transferClaims(userId, conn);
  const plan = planLinks({
    sources,
    candidates: loadCandidates(userId, sources, accountList, conn),
    accounts: accountList,
    taken,
    pending,
  });
  const result = { ...NONE };
  for (const link of plan) {
    apply(userId, link, conn);
    if (link.kind === "pair") result.paired += 1;
    else if (link.kind === "mirror") result.mirrored += 1;
    else result.needsAmount += 1;
  }
  return result;
}

/**
 * After rows were written to `accountId`: looks at them as sources, and at
 * rows on other accounts that name this account's IBAN near their dates, so
 * a late counterpart pairs with what is already there.
 */
export function linkAfterWrite(
  userId: string,
  accountId: string,
  transactionIds: readonly string[],
  dates: readonly string[],
  conn: Conn,
): LinkResult {
  if (transactionIds.length === 0) return { ...NONE };
  const sorted = [...dates].sort();
  return linkTransfers(
    userId,
    {
      transactionIds,
      targetAccountId: accountId,
      from: shiftDate(sorted[0]!, -LINK_WINDOW_DAYS),
      to: shiftDate(sorted[sorted.length - 1]!, LINK_WINDOW_DAYS),
    },
    conn,
  );
}
