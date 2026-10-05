import { ledgerLock } from "$lib/server/ledger/lock";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  accounts,
  first,
  getDB,
  imports,
  transactions,
  transfers,
  type DB,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import {
  linkTransfersInTx,
  loadPlanAccounts,
  loadPlanAccountsInTx,
  type LinkResult,
  type Tx,
} from "./link";
import { notInLinkedTransfer } from "./exclusion";
import {
  LINK_WINDOW_DAYS,
  canMirrorOnto,
  counterAmount,
  daysApart,
  shiftDate,
} from "./plan";

type TransferRow = typeof transfers.$inferSelect;

type Reader = Pick<DB, "select">;

async function ownedTransfer(
  tx: Tx,
  userId: string,
  transferId: string,
): Promise<TransferRow> {
  const row = await first(
    tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.userId, userId), eq(transfers.id, transferId)))
      .limit(1),
  );
  if (!row) throw notFound("Transfer");
  return row;
}

function ownedTransactionQuery(conn: Reader, userId: string, id: string) {
  return conn
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .limit(1);
}

async function ownedTransaction(tx: Tx, userId: string, id: string) {
  const row = await first(ownedTransactionQuery(tx, userId, id));
  if (!row) throw notFound("Transaction");
  return row;
}

/** Rows of any status that reference the transaction on either side. */
async function rowsReferencing(tx: Tx, userId: string, transactionId: string) {
  return await tx
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        or(
          eq(transfers.outTransactionId, transactionId),
          eq(transfers.inTransactionId, transactionId),
        ),
      ),
    );
}

/** Takes a transaction out of its dismissed and needs-amount rows; a row left without a side goes. */
async function release(
  tx: Tx,
  userId: string,
  transactionId: string,
): Promise<void> {
  for (const row of await rowsReferencing(tx, userId, transactionId)) {
    if (row.status === "linked") continue;
    const outId =
      row.outTransactionId === transactionId ? null : row.outTransactionId;
    const inId =
      row.inTransactionId === transactionId ? null : row.inTransactionId;
    if (row.status === "needs_amount" || (outId === null && inId === null)) {
      await tx.delete(transfers).where(eq(transfers.id, row.id));
    } else {
      await tx
        .update(transfers)
        .set({ outTransactionId: outId, inTransactionId: inId })
        .where(eq(transfers.id, row.id));
    }
  }
}

/**
 * Remembers an unlink: the transfer becomes `dismissed` so the engine never
 * recreates that pair or mirror. A mirror is deleted; the paired rows stay.
 */
export async function unlink(
  userId: string,
  transferId: string,
): Promise<void> {
  await transaction(
    async (tx) => {
      const row = await ownedTransfer(tx, userId, transferId);
      if (row.status === "dismissed") return;
      const ids = [row.outTransactionId, row.inTransactionId].filter(
        (id): id is string => id !== null,
      );
      const mirrors = new Set(
        ids.length === 0
          ? []
          : (
              await tx
                .select({ id: transactions.id })
                .from(transactions)
                .where(
                  and(
                    inArray(transactions.id, ids),
                    eq(transactions.source, "mirror"),
                  ),
                )
            ).map((m) => m.id),
      );
      // The mirror's id leaves the row first, or deleting it would delete the row too.
      await tx
        .update(transfers)
        .set({
          status: "dismissed",
          outTransactionId:
            row.outTransactionId && mirrors.has(row.outTransactionId)
              ? null
              : row.outTransactionId,
          inTransactionId:
            row.inTransactionId && mirrors.has(row.inTransactionId)
              ? null
              : row.inTransactionId,
        })
        .where(eq(transfers.id, row.id));
      if (mirrors.size > 0) {
        await tx
          .delete(transactions)
          .where(inArray(transactions.id, [...mirrors]));
      }
    },
    { lock: ledgerLock(userId) },
  );
}

/**
 * Links two existing rows as one transfer: `outId` is the debit, `inId` the
 * credit. They must belong to different accounts of the user, have opposite
 * signs and not be linked already (a dismissed or needs-amount row is
 * replaced). Returns the transfer's id.
 */
export async function linkManually(
  userId: string,
  outId: string,
  inId: string,
): Promise<string> {
  return await transaction(
    async (tx) => linkManuallyInTx(tx, userId, outId, inId),
    { lock: ledgerLock(userId) },
  );
}

/** `linkManually` on a transaction you already hold. */
async function linkManuallyInTx(
  tx: Tx,
  userId: string,
  outId: string,
  inId: string,
): Promise<string> {
  if (outId === inId) {
    throw new LedgerError("invalid", "Choose two different transactions.");
  }
  const out = await ownedTransaction(tx, userId, outId);
  const into = await ownedTransaction(tx, userId, inId);
  if (out.accountId === into.accountId) {
    throw new LedgerError(
      "invalid",
      "The two transactions must be on different accounts.",
    );
  }
  if (!(out.amount < 0 && into.amount > 0)) {
    throw new LedgerError(
      "invalid",
      "A transfer needs one debit and one credit.",
    );
  }
  for (const id of [out.id, into.id]) {
    if (
      (await rowsReferencing(tx, userId, id)).some((r) => r.status === "linked")
    ) {
      throw new LedgerError(
        "conflict",
        "One of the transactions is already part of a transfer.",
      );
    }
  }
  await release(tx, userId, out.id);
  await release(tx, userId, into.id);
  return (await first(
    tx
      .insert(transfers)
      .values({
        userId,
        outTransactionId: out.id,
        inTransactionId: into.id,
        status: "linked",
        method: "manual",
        fromAccountId: out.accountId,
        toAccountId: into.accountId,
      })
      .returning({ id: transfers.id }),
  ))!.id;
}

/** A booked row on the receiving account that may be the real other side of a needs-amount transfer. */
export interface LinkCandidate {
  id: string;
  bookingDate: string;
  amount: Minor;
  currency: string;
  description: string | null;
}

/** Resolving was refused because `candidateId` may be the other side: link it instead. */
export class LinkInsteadError extends LedgerError {
  override name = "LinkInsteadError";
  constructor(
    message: string,
    readonly candidateId: string,
  ) {
    super("conflict", message);
  }
}

function linkCandidateQuery(
  conn: Reader,
  userId: string,
  source: { bookingDate: string; amount: number },
  home: { iban: string | null },
  target: { id: string },
) {
  const outgoing = source.amount < 0;
  return conn
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      currency: transactions.currency,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, target.id),
        ne(transactions.source, "mirror"),
        outgoing
          ? sql`${transactions.amount} > 0`
          : sql`${transactions.amount} < 0`,
        gte(
          transactions.bookingDate,
          shiftDate(source.bookingDate, -LINK_WINDOW_DAYS),
        ),
        lte(
          transactions.bookingDate,
          shiftDate(source.bookingDate, LINK_WINDOW_DAYS),
        ),
        home.iban === null
          ? sql`${transactions.counterpartyIban} is null`
          : or(
              sql`${transactions.counterpartyIban} is null`,
              sql`upper(replace(${transactions.counterpartyIban}, ' ', '')) = ${home.iban}`,
            ),
        notInLinkedTransfer,
      ),
    );
}

function nearestCandidate(
  source: { bookingDate: string },
  rows: LinkCandidate[],
): LinkCandidate | null {
  rows.sort(
    (a, b) =>
      daysApart(source.bookingDate, a.bookingDate) -
        daysApart(source.bookingDate, b.bookingDate) ||
      a.id.localeCompare(b.id),
  );
  return rows[0] ?? null;
}

/**
 * The booked row on `target` nearest to the source's date that may be the real
 * other side: opposite direction, within the window, in no linked transfer and
 * with a counterparty that is absent or the source's account (a row naming
 * someone else is another payment). Null when there is none.
 */
async function findLinkCandidate(
  userId: string,
  source: { bookingDate: string; amount: number },
  home: { iban: string | null },
  target: { id: string },
): Promise<LinkCandidate | null> {
  const rows = await linkCandidateQuery(getDB(), userId, source, home, target);
  return nearestCandidate(source, rows);
}

/** `findLinkCandidate` on a transaction you already hold. */
async function findLinkCandidateInTx(
  tx: Reader,
  userId: string,
  source: { bookingDate: string; amount: number },
  home: { iban: string | null },
  target: { id: string },
): Promise<LinkCandidate | null> {
  return nearestCandidate(
    source,
    await linkCandidateQuery(tx, userId, source, home, target),
  );
}

export interface NeedsAmountView {
  transferId: string;
  sourceTransactionId: string;
  sourceAccountId: string;
  sourceAccountName: string;
  /** The account that has to receive the counter-transaction. */
  targetAccountId: string;
  targetAccountName: string;
  targetCurrency: string;
  /** From the target's side: money arrives ("in") when the source is a debit. */
  direction: "in" | "out";
  bookingDate: string;
  /** The source row's own amount and currency. */
  amount: Minor;
  currency: string;
  description: string | null;
  /** A booked row on the receiving account that may be the other side: link it instead of entering an amount. */
  linkCandidate: LinkCandidate | null;
}

const SOURCE_CHUNK = 500;

/** FX transfers waiting for the amount the other account booked, newest first. */
export async function listNeedsAmount(
  userId: string,
  accountId?: string,
): Promise<NeedsAmountView[]> {
  const db = getDB();
  const rows = await db
    .select()
    .from(transfers)
    .where(
      and(eq(transfers.userId, userId), eq(transfers.status, "needs_amount")),
    );
  const names = new Map(
    (
      await db
        .select({
          id: accounts.id,
          name: accounts.name,
          currency: accounts.currency,
        })
        .from(accounts)
        .where(eq(accounts.userId, userId))
    ).map((a) => [a.id, a]),
  );
  const sourceIds = [
    ...new Set(
      rows
        .map((r) => r.outTransactionId ?? r.inTransactionId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const sources = new Map<string, typeof transactions.$inferSelect>();
  for (let i = 0; i < sourceIds.length; i += SOURCE_CHUNK) {
    for (const t of await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, sourceIds.slice(i, i + SOURCE_CHUNK)),
        ),
      )) {
      sources.set(t.id, t);
    }
  }
  const ibans = new Map(
    (await loadPlanAccounts(userId)).map((a) => [a.id, a.iban]),
  );
  const views: NeedsAmountView[] = [];
  for (const r of rows) {
    const sourceId = r.outTransactionId ?? r.inTransactionId;
    if (sourceId === null) continue;
    const src = sources.get(sourceId);
    if (!src) continue;
    const outgoing = r.outTransactionId !== null;
    const targetId = outgoing ? r.toAccountId : r.fromAccountId;
    const source = names.get(src.accountId);
    const target = names.get(targetId);
    if (!source || !target) continue;
    if (accountId !== undefined && targetId !== accountId) continue;
    views.push({
      transferId: r.id,
      sourceTransactionId: src.id,
      sourceAccountId: src.accountId,
      sourceAccountName: source.name,
      targetAccountId: targetId,
      targetAccountName: target.name,
      targetCurrency: target.currency,
      direction: outgoing ? "in" : "out",
      bookingDate: src.bookingDate,
      amount: src.amount,
      currency: src.currency,
      description: src.description,
      linkCandidate: await findLinkCandidate(
        userId,
        src,
        { iban: ibans.get(src.accountId) ?? null },
        { id: targetId },
      ),
    });
  }
  return views.sort(
    (a, b) =>
      b.bookingDate.localeCompare(a.bookingDate) ||
      a.transferId.localeCompare(b.transferId),
  );
}

/**
 * Creates the counter-transaction of a `needs_amount` transfer. `amount` is
 * the positive amount the target account booked, in its currency.
 */
export async function resolveNeedsAmount(
  userId: string,
  transferId: string,
  amount: Minor,
): Promise<void> {
  await transaction(
    async (tx) => {
      const row = await ownedTransfer(tx, userId, transferId);
      if (row.status !== "needs_amount") {
        throw new LedgerError("conflict", "This transfer needs no amount.");
      }
      if (amount <= 0) {
        throw new LedgerError(
          "invalid",
          "Enter the amount that arrived, above zero.",
          "amount",
        );
      }
      const outgoing = row.outTransactionId !== null;
      const source = await ownedTransaction(
        tx,
        userId,
        (outgoing ? row.outTransactionId : row.inTransactionId)!,
      );
      const plan = await loadPlanAccountsInTx(tx, userId);
      const home = plan.find((a) => a.id === source.accountId);
      const target = plan.find(
        (a) => a.id === (outgoing ? row.toAccountId : row.fromAccountId),
      );
      if (!home || !target) throw notFound("Account");
      if (!canMirrorOnto(target, source.bookingDate)) {
        throw new LedgerError(
          "conflict",
          "The receiving account is no longer filled from transfers.",
        );
      }
      // A booked row that may be the real counterpart: link it instead of booking a second one.
      const counterpart = await findLinkCandidateInTx(
        tx,
        userId,
        source,
        home,
        target,
      );
      if (counterpart) {
        throw new LinkInsteadError(
          `The receiving account has a transaction on ${counterpart.bookingDate} that may be the other side of this transfer. Link it instead of entering an amount.`,
          counterpart.id,
        );
      }
      const mirror = await first(
        tx
          .insert(transactions)
          .values({
            userId,
            accountId: target.id,
            importId: null,
            source: "mirror",
            externalId: `mirror:${source.id}`,
            mirrorOfId: source.id,
            bookingDate: source.bookingDate,
            valueDate: source.valueDate,
            amount: minor(outgoing ? amount : -amount),
            currency: target.currency,
            counterpartyName: home.name,
            counterpartyIban: home.iban,
            description: source.description,
            reference: source.reference,
            referenceType: source.referenceType,
            reversal: false,
          })
          .onConflictDoNothing({
            target: [transactions.accountId, transactions.externalId],
          })
          .returning({ id: transactions.id }),
      );
      if (!mirror) {
        throw new LedgerError(
          "conflict",
          "A counter-transaction for this transfer already exists.",
        );
      }
      await tx
        .update(transfers)
        .set({
          status: "linked",
          method: "mirrored",
          ...(outgoing
            ? { inTransactionId: mirror.id }
            : { outTransactionId: mirror.id }),
        })
        .where(eq(transfers.id, row.id));
    },
    { lock: ledgerLock(userId) },
  );
}

/**
 * Links the source of a needs-amount transfer to a booked row of the
 * receiving account instead of creating a counter-transaction. Returns the
 * transfer's id.
 */
export async function linkNeedsAmountTo(
  userId: string,
  transferId: string,
  peerId: string,
): Promise<string> {
  return await transaction(
    async (tx) => {
      const row = await ownedTransfer(tx, userId, transferId);
      if (row.status !== "needs_amount") {
        throw new LedgerError("conflict", "This transfer needs no amount.");
      }
      const outgoing = row.outTransactionId !== null;
      const sourceId = (outgoing ? row.outTransactionId : row.inTransactionId)!;
      const peer = await ownedTransaction(tx, userId, peerId);
      if (peer.accountId !== (outgoing ? row.toAccountId : row.fromAccountId)) {
        throw new LedgerError(
          "invalid",
          "Choose a transaction of the receiving account.",
        );
      }
      return outgoing
        ? linkManuallyInTx(tx, userId, sourceId, peer.id)
        : linkManuallyInTx(tx, userId, peer.id, sourceId);
    },
    { lock: ledgerLock(userId) },
  );
}

export const CANDIDATE_WINDOW_DAYS = 10;
const MAX_CANDIDATES = 25;

export interface TransferCandidate {
  id: string;
  accountId: string;
  accountName: string;
  bookingDate: string;
  amount: Minor;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  /** The amount equals the transaction's (or its original amount in this currency). */
  exact: boolean;
  /** Days between the two booking dates. */
  days: number;
}

/**
 * Rows on the user's other accounts that could be the other side of a
 * transaction: opposite sign, within ten days, not part of a transfer yet.
 * Equal amounts come first, then the closest date.
 */
export async function transferCandidates(
  userId: string,
  transactionId: string,
): Promise<TransferCandidate[]> {
  const db = getDB();
  const subject = await first(ownedTransactionQuery(db, userId, transactionId));
  if (!subject) throw notFound("Transaction");
  if (subject.source === "mirror") return [];
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      accountCurrency: accounts.currency,
      bookingDate: transactions.bookingDate,
      amount: transactions.amount,
      currency: transactions.currency,
      counterpartyName: transactions.counterpartyName,
      description: transactions.description,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(accounts.userId, userId),
        ne(transactions.accountId, subject.accountId),
        ne(transactions.source, "mirror"),
        subject.amount < 0
          ? sql`${transactions.amount} > 0`
          : sql`${transactions.amount} < 0`,
        gte(
          transactions.bookingDate,
          shiftDate(subject.bookingDate, -CANDIDATE_WINDOW_DAYS),
        ),
        lte(
          transactions.bookingDate,
          shiftDate(subject.bookingDate, CANDIDATE_WINDOW_DAYS),
        ),
        sql`not exists (select 1 from ${transfers} where ${transfers.status} = 'linked' and (${transfers.outTransactionId} = ${transactions.id} or ${transfers.inTransactionId} = ${transactions.id}))`,
      ),
    )
    .orderBy(
      asc(transactions.bookingDate),
      desc(transactions.seq),
      desc(transactions.id),
    );
  const candidates = rows.map((r): TransferCandidate => {
    const expected = counterAmount(subject, { currency: r.currency });
    return {
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName,
      bookingDate: r.bookingDate,
      amount: r.amount,
      currency: r.currency,
      counterpartyName: r.counterpartyName,
      description: r.description,
      exact: expected !== null && Math.abs(expected) === Math.abs(r.amount),
      days: daysApart(subject.bookingDate, r.bookingDate),
    };
  });
  return candidates
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        a.days - b.days ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_CANDIDATES);
}

/** Deletes the mirrors on an account and the needs-amount rows waiting for it (the toggle went off). */
export async function removeMirrors(
  tx: Tx,
  userId: string,
  accountId: string,
): Promise<number> {
  await tx
    .delete(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        eq(transfers.status, "needs_amount"),
        or(
          and(
            sql`${transfers.outTransactionId} is not null`,
            eq(transfers.toAccountId, accountId),
          ),
          and(
            sql`${transfers.inTransactionId} is not null`,
            eq(transfers.fromAccountId, accountId),
          ),
        ),
      ),
    );
  return (
    await tx
      .delete(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
          eq(transactions.source, "mirror"),
        ),
      )
      .returning({ id: transactions.id })
  ).length;
}

export interface FillSuggestion {
  /** Transfers on other accounts that name this account's IBAN and have no counter-transaction. */
  count: number;
}

/**
 * For an account that was never imported and is not filled from transfers:
 * how many transfers to or from its IBAN show up on the user's other accounts.
 * Null when filling is not possible or nothing was found.
 */
export async function fillSuggestion(
  userId: string,
  accountId: string,
): Promise<FillSuggestion | null> {
  const db = getDB();
  const account = (await loadPlanAccounts(userId)).find(
    (a) => a.id === accountId,
  );
  if (!account) throw notFound("Account");
  if (
    account.fillFromTransfers ||
    account.archived ||
    account.iban === null ||
    account.type === "pillar_3a" ||
    account.hasPortfolios
  ) {
    return null;
  }
  const imported = await first(
    db
      .select({ id: imports.id })
      .from(imports)
      .where(and(eq(imports.userId, userId), eq(imports.accountId, accountId)))
      .limit(1),
  );
  if (imported) return null;
  const rows = (
    await db
      .select({ id: transactions.id, bookingDate: transactions.bookingDate })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          ne(transactions.accountId, accountId),
          ne(transactions.source, "mirror"),
          sql`upper(replace(${transactions.counterpartyIban}, ' ', '')) = ${account.iban}`,
          sql`not exists (select 1 from ${transfers} where ${transfers.outTransactionId} = ${transactions.id} or ${transfers.inTransactionId} = ${transactions.id})`,
        ),
      )
  ).filter(
    (r) => account.openingDate === null || r.bookingDate >= account.openingDate,
  );
  return rows.length > 0 ? { count: rows.length } : null;
}

/** Turns on `fillFromTransfers` for an account and backfills its history. */
export async function enableFill(
  userId: string,
  accountId: string,
): Promise<LinkResult> {
  return await transaction(
    async (tx) => {
      const account = (await loadPlanAccountsInTx(tx, userId)).find(
        (a) => a.id === accountId,
      );
      if (!account) throw notFound("Account");
      if (account.archived) {
        throw new LedgerError(
          "invalid",
          "An archived account cannot be filled from transfers. Restore it first.",
        );
      }
      if (account.type === "pillar_3a" || account.hasPortfolios) {
        throw new LedgerError(
          "invalid",
          "Pillar 3a accounts cannot be filled from transfers.",
        );
      }
      if (account.iban === null) {
        throw new LedgerError(
          "invalid",
          "The account needs an IBAN to be filled from transfers.",
          "iban",
        );
      }
      await tx
        .update(accounts)
        .set({ fillFromTransfers: true })
        .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)));
      return linkTransfersInTx(tx, userId, { targetAccountId: accountId });
    },
    { lock: ledgerLock(userId) },
  );
}

function mirrorCountQuery(conn: Reader, userId: string, accountId: string) {
  return conn
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.source, "mirror"),
      ),
    );
}

/** Number of mirrors on an account. */
export async function countMirrors(
  userId: string,
  accountId: string,
): Promise<number> {
  const row = await first(mirrorCountQuery(getDB(), userId, accountId));
  return row?.n ?? 0;
}

/** `countMirrors` on a transaction you already hold. */
export async function countMirrorsInTx(
  tx: Reader,
  userId: string,
  accountId: string,
): Promise<number> {
  return (await first(mirrorCountQuery(tx, userId, accountId)))?.n ?? 0;
}
