import { ledgerLock } from "$lib/server/ledger/lock";
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
  first,
  transaction,
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

/** A transaction (or the database): what the in-transaction helpers write through. */
export type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;
type Reader = Pick<DB, "select">;

const CHUNK = 500;

function planAccountQueries(conn: Reader, userId: string) {
  return {
    withPortfolios: conn
      .select({ id: portfolios.accountId })
      .from(portfolios)
      .where(eq(portfolios.userId, userId)),
    accounts: conn
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
      .where(eq(accounts.userId, userId)),
  };
}

function toPlanAccounts(
  portfolioRows: readonly { id: string }[],
  accountRows: readonly Omit<PlanAccount, "hasPortfolios">[],
): PlanAccount[] {
  const withPortfolios = new Set(portfolioRows.map((r) => r.id));
  return accountRows.map((a) => ({
    ...a,
    iban: a.iban ? normalizeIban(a.iban) : null,
    hasPortfolios: withPortfolios.has(a.id),
  }));
}

export async function loadPlanAccounts(userId: string): Promise<PlanAccount[]> {
  const q = planAccountQueries(getDB(), userId);
  return toPlanAccounts(await q.withPortfolios, await q.accounts);
}

/** `loadPlanAccounts` on a transaction you already hold. */
export async function loadPlanAccountsInTx(
  tx: Reader,
  userId: string,
): Promise<PlanAccount[]> {
  const q = planAccountQueries(tx, userId);
  return toPlanAccounts(await q.withPortfolios, await q.accounts);
}

/**
 * Normalized IBAN -> account id for the user's accounts, archived ones
 * included. Only `iban` counts: a deposit IBAN (a QR-IBAN) is shared by many
 * customers, and pillar 3a payments are recognised by their reference.
 */
export async function ownIbans(userId: string): Promise<Map<string, string>> {
  return new Map(
    [...accountsByIban(await loadPlanAccounts(userId))].map(([iban, a]) => [
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
export async function transferClaims(
  tx: Tx,
  userId: string,
): Promise<{ taken: Set<string>; pending: Set<string> }> {
  const taken = new Set<string>();
  const pending = new Set<string>();
  for (const r of await tx
    .select({
      out: transfers.outTransactionId,
      in: transfers.inTransactionId,
      status: transfers.status,
    })
    .from(transfers)
    .where(eq(transfers.userId, userId))) {
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

async function loadSources(
  tx: Tx,
  userId: string,
  scope: LinkScope,
  accountList: readonly PlanAccount[],
): Promise<PlanTransaction[]> {
  const base = [
    eq(transactions.userId, userId),
    ne(transactions.source, "mirror"),
    sql`${transactions.counterpartyIban} is not null`,
    scope.from ? gte(transactions.bookingDate, scope.from) : undefined,
    scope.to ? lte(transactions.bookingDate, scope.to) : undefined,
  ];
  const pick = async (extra: ReturnType<typeof eq> | undefined) =>
    await tx
      .select(planColumns)
      .from(transactions)
      .where(and(...base, extra));

  const scoped =
    scope.transactionIds !== undefined ||
    scope.sourceAccountId !== undefined ||
    scope.targetAccountId !== undefined;
  const found = new Map<string, PlanTransaction>();
  const add = (rows: PlanTransaction[]) => {
    for (const r of rows) found.set(r.id, r);
  };
  if (!scoped) add(await pick(undefined));
  if (scope.transactionIds) {
    for (let i = 0; i < scope.transactionIds.length; i += CHUNK) {
      add(
        await pick(
          inArray(
            transactions.id,
            scope.transactionIds.slice(i, i + CHUNK) as string[],
          ),
        ),
      );
    }
  }
  if (scope.sourceAccountId !== undefined) {
    add(await pick(eq(transactions.accountId, scope.sourceAccountId)));
  }
  if (scope.targetAccountId !== undefined) {
    const iban = accountList.find((a) => a.id === scope.targetAccountId)?.iban;
    if (iban) {
      add(
        await pick(
          sql`upper(replace(${transactions.counterpartyIban}, ' ', '')) = ${iban}`,
        ),
      );
    }
  }
  return [...found.values()];
}

async function loadCandidates(
  tx: Tx,
  userId: string,
  sources: readonly PlanTransaction[],
  accountList: readonly PlanAccount[],
): Promise<PlanTransaction[]> {
  const byIban = accountsByIban(accountList);
  const targetIds = new Set<string>();
  let earliest = "9999-12-31";
  let latest = "0000-01-01";
  for (const s of sources) {
    const target = byIban.get(normalizeIban(s.counterpartyIban!));
    if (!target) continue;
    targetIds.add(target.id);
    if (s.bookingDate < earliest) earliest = s.bookingDate;
    if (s.bookingDate > latest) latest = s.bookingDate;
  }
  if (targetIds.size === 0) return [];
  return await tx
    .select(planColumns)
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        ne(transactions.source, "mirror"),
        inArray(transactions.accountId, [...targetIds]),
        gte(transactions.bookingDate, shiftDate(earliest, -LINK_WINDOW_DAYS)),
        lte(transactions.bookingDate, shiftDate(latest, LINK_WINDOW_DAYS)),
      ),
    );
}

/** Deletes the needs-amount rows of these transactions: their counter-side exists now. */
async function dropWaiting(
  tx: Tx,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  await tx
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
    );
}

async function apply(tx: Tx, userId: string, link: PlannedLink): Promise<void> {
  if (link.kind === "pair") {
    await dropWaiting(tx, userId, [link.sourceId, link.candidateId]);
  } else if (link.kind === "mirror") {
    await dropWaiting(tx, userId, [link.sourceId]);
  }
  let outId = link.outTransactionId;
  let inId = link.inTransactionId;
  let status: "linked" | "needs_amount" = "linked";
  let method: "paired" | "mirrored" = "paired";
  if (link.kind === "mirror") {
    method = "mirrored";
    const m = link.mirror;
    const externalId = `mirror:${link.sourceId}`;
    const created = await first(
      tx
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
        .returning({ id: transactions.id }),
    );
    const mirrorId =
      created?.id ??
      (await first(
        tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              eq(transactions.accountId, m.accountId),
              eq(transactions.externalId, externalId),
            ),
          )
          .limit(1),
      ))!.id;
    if (outId === null) outId = mirrorId;
    else inId = mirrorId;
  } else if (link.kind === "needs_amount") {
    status = "needs_amount";
    method = "mirrored";
  }
  await tx.insert(transfers).values({
    userId,
    outTransactionId: outId,
    inTransactionId: inId,
    status,
    method,
    fromAccountId: link.fromAccountId,
    toAccountId: link.toAccountId,
  });
}

/**
 * Looks at the rows selected by `scope` (all of the user's rows without a
 * scope) and links the transfers between the user's own accounts: pairs the
 * two booked sides, or mirrors the missing one onto an account that is filled
 * from transfers (see `planLinks`). Rows that already have a transfers row,
 * dismissed ones included, are left alone; a row waiting for an amount pairs
 * with its real counterpart once that shows up. This one opens its own
 * transaction; `linkTransfersInTx` runs inside one you already hold.
 */
export async function linkTransfers(
  userId: string,
  scope: LinkScope = {},
): Promise<LinkResult> {
  return await transaction(async (tx) => linkTransfersInTx(tx, userId, scope), {
    lock: ledgerLock(userId),
  });
}

/** `linkTransfers` on a transaction you already hold. */
export async function linkTransfersInTx(
  tx: Tx,
  userId: string,
  scope: LinkScope = {},
): Promise<LinkResult> {
  const accountList = await loadPlanAccountsInTx(tx, userId);
  const sources = await loadSources(tx, userId, scope, accountList);
  if (sources.length === 0) return { ...NONE };
  const { taken, pending } = await transferClaims(tx, userId);
  const plan = planLinks({
    sources,
    candidates: await loadCandidates(tx, userId, sources, accountList),
    accounts: accountList,
    taken,
    pending,
  });
  const result = { ...NONE };
  for (const link of plan) {
    await apply(tx, userId, link);
    if (link.kind === "pair") result.paired += 1;
    else if (link.kind === "mirror") result.mirrored += 1;
    else result.needsAmount += 1;
  }
  return result;
}

/**
 * After rows were written to `accountId`: looks at them as sources, and at
 * rows on other accounts that name this account's IBAN near their dates, so
 * a late counterpart pairs with what is already there. Runs inside the
 * transaction that wrote the rows.
 */
export async function linkAfterWrite(
  tx: Tx,
  userId: string,
  accountId: string,
  transactionIds: readonly string[],
  dates: readonly string[],
): Promise<LinkResult> {
  if (transactionIds.length === 0) return { ...NONE };
  const sorted = [...dates].sort();
  return await linkTransfersInTx(tx, userId, {
    transactionIds,
    targetAccountId: accountId,
    from: shiftDate(sorted[0]!, -LINK_WINDOW_DAYS),
    to: shiftDate(sorted[sorted.length - 1]!, LINK_WINDOW_DAYS),
  });
}
