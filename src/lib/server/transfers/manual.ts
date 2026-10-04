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
  getDB,
  imports,
  transactions,
  transfers,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import {
  linkTransfers,
  loadPlanAccounts,
  type Conn,
  type LinkResult,
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

function ownedTransfer(
  userId: string,
  transferId: string,
  conn: Conn,
): TransferRow {
  const row = conn
    .select()
    .from(transfers)
    .where(and(eq(transfers.userId, userId), eq(transfers.id, transferId)))
    .get();
  if (!row) throw notFound("Transfer");
  return row;
}

function ownedTransaction(userId: string, id: string, conn: Conn) {
  const row = conn
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .get();
  if (!row) throw notFound("Transaction");
  return row;
}

/** Rows of any status that reference the transaction on either side. */
function rowsReferencing(userId: string, transactionId: string, conn: Conn) {
  return conn
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
    )
    .all();
}

/** Takes a transaction out of its dismissed and needs-amount rows; a row left without a side goes. */
function release(userId: string, transactionId: string, conn: Conn): void {
  for (const row of rowsReferencing(userId, transactionId, conn)) {
    if (row.status === "linked") continue;
    const outId =
      row.outTransactionId === transactionId ? null : row.outTransactionId;
    const inId =
      row.inTransactionId === transactionId ? null : row.inTransactionId;
    if (row.status === "needs_amount" || (outId === null && inId === null)) {
      conn.delete(transfers).where(eq(transfers.id, row.id)).run();
    } else {
      conn
        .update(transfers)
        .set({ outTransactionId: outId, inTransactionId: inId })
        .where(eq(transfers.id, row.id))
        .run();
    }
  }
}

/**
 * Remembers an unlink: the transfer becomes `dismissed` so the engine never
 * recreates that pair or mirror. A mirror is deleted; the paired rows stay.
 */
export function unlink(userId: string, transferId: string): void {
  getDB().transaction((tx) => {
    const row = ownedTransfer(userId, transferId, tx);
    if (row.status === "dismissed") return;
    const ids = [row.outTransactionId, row.inTransactionId].filter(
      (id): id is string => id !== null,
    );
    const mirrors = new Set(
      ids.length === 0
        ? []
        : tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                inArray(transactions.id, ids),
                eq(transactions.source, "mirror"),
              ),
            )
            .all()
            .map((m) => m.id),
    );
    // The mirror's id leaves the row first, or deleting it would delete the row too.
    tx.update(transfers)
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
      .where(eq(transfers.id, row.id))
      .run();
    if (mirrors.size > 0) {
      tx.delete(transactions)
        .where(inArray(transactions.id, [...mirrors]))
        .run();
    }
  });
}

/**
 * Links two existing rows as one transfer: `outId` is the debit, `inId` the
 * credit. They must belong to different accounts of the user, have opposite
 * signs and not be linked already (a dismissed or needs-amount row is
 * replaced). Returns the transfer's id.
 */
export function linkManually(
  userId: string,
  outId: string,
  inId: string,
): string {
  return getDB().transaction((tx) => {
    if (outId === inId) {
      throw new LedgerError("invalid", "Choose two different transactions.");
    }
    const out = ownedTransaction(userId, outId, tx);
    const into = ownedTransaction(userId, inId, tx);
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
      if (rowsReferencing(userId, id, tx).some((r) => r.status === "linked")) {
        throw new LedgerError(
          "conflict",
          "One of the transactions is already part of a transfer.",
        );
      }
    }
    release(userId, out.id, tx);
    release(userId, into.id, tx);
    return tx
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
      .returning({ id: transfers.id })
      .get().id;
  });
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
}

const SOURCE_CHUNK = 500;

/** FX transfers waiting for the amount the other account booked, newest first. */
export function listNeedsAmount(
  userId: string,
  accountId?: string,
): NeedsAmountView[] {
  const db = getDB();
  const rows = db
    .select()
    .from(transfers)
    .where(
      and(eq(transfers.userId, userId), eq(transfers.status, "needs_amount")),
    )
    .all();
  const names = new Map(
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        currency: accounts.currency,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
      .map((a) => [a.id, a]),
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
    for (const t of db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, sourceIds.slice(i, i + SOURCE_CHUNK)),
        ),
      )
      .all()) {
      sources.set(t.id, t);
    }
  }
  const views: NeedsAmountView[] = [];
  for (const r of rows) {
    const sourceId = r.outTransactionId ?? r.inTransactionId;
    if (sourceId === null) continue;
    const tx = sources.get(sourceId);
    if (!tx) continue;
    const outgoing = r.outTransactionId !== null;
    const targetId = outgoing ? r.toAccountId : r.fromAccountId;
    const source = names.get(tx.accountId);
    const target = names.get(targetId);
    if (!source || !target) continue;
    if (accountId !== undefined && targetId !== accountId) continue;
    views.push({
      transferId: r.id,
      sourceTransactionId: tx.id,
      sourceAccountId: tx.accountId,
      sourceAccountName: source.name,
      targetAccountId: targetId,
      targetAccountName: target.name,
      targetCurrency: target.currency,
      direction: outgoing ? "in" : "out",
      bookingDate: tx.bookingDate,
      amount: tx.amount,
      currency: tx.currency,
      description: tx.description,
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
export function resolveNeedsAmount(
  userId: string,
  transferId: string,
  amount: Minor,
): void {
  getDB().transaction((tx) => {
    const row = ownedTransfer(userId, transferId, tx);
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
    const source = ownedTransaction(
      userId,
      (outgoing ? row.outTransactionId : row.inTransactionId)!,
      tx,
    );
    const plan = loadPlanAccounts(userId, tx);
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
    const counterpart = tx
      .select({ id: transactions.id })
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
          notInLinkedTransfer,
        ),
      )
      .get();
    if (counterpart) {
      throw new LedgerError(
        "conflict",
        "The receiving account has a transaction that may be the other side of this transfer. Link them instead of entering an amount.",
      );
    }
    const mirror = tx
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
      .returning({ id: transactions.id })
      .get();
    if (!mirror) {
      throw new LedgerError(
        "conflict",
        "A counter-transaction for this transfer already exists.",
      );
    }
    tx.update(transfers)
      .set({
        status: "linked",
        method: "mirrored",
        ...(outgoing
          ? { inTransactionId: mirror.id }
          : { outTransactionId: mirror.id }),
      })
      .where(eq(transfers.id, row.id))
      .run();
  });
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
export function transferCandidates(
  userId: string,
  transactionId: string,
): TransferCandidate[] {
  const db = getDB();
  const tx = ownedTransaction(userId, transactionId, db);
  if (tx.source === "mirror") return [];
  const rows = db
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
        ne(transactions.accountId, tx.accountId),
        ne(transactions.source, "mirror"),
        tx.amount < 0
          ? sql`${transactions.amount} > 0`
          : sql`${transactions.amount} < 0`,
        gte(
          transactions.bookingDate,
          shiftDate(tx.bookingDate, -CANDIDATE_WINDOW_DAYS),
        ),
        lte(
          transactions.bookingDate,
          shiftDate(tx.bookingDate, CANDIDATE_WINDOW_DAYS),
        ),
        sql`not exists (select 1 from ${transfers} where ${transfers.status} = 'linked' and (${transfers.outTransactionId} = ${transactions.id} or ${transfers.inTransactionId} = ${transactions.id}))`,
      ),
    )
    .orderBy(asc(transactions.bookingDate), desc(sql`"transactions"."rowid"`))
    .all();
  const candidates = rows.map((r): TransferCandidate => {
    const expected = counterAmount(tx, { currency: r.currency });
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
      days: daysApart(tx.bookingDate, r.bookingDate),
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
export function removeMirrors(
  userId: string,
  accountId: string,
  conn: Conn,
): number {
  conn
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
    )
    .run();
  return conn
    .delete(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.source, "mirror"),
      ),
    )
    .returning({ id: transactions.id })
    .all().length;
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
export function fillSuggestion(
  userId: string,
  accountId: string,
): FillSuggestion | null {
  const db = getDB();
  const account = loadPlanAccounts(userId, db).find((a) => a.id === accountId);
  if (!account) throw notFound("Account");
  if (
    account.fillFromTransfers ||
    account.iban === null ||
    account.type === "pillar_3a" ||
    account.hasPortfolios
  ) {
    return null;
  }
  const imported = db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.userId, userId), eq(imports.accountId, accountId)))
    .get();
  if (imported) return null;
  const rows = db
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
    .all()
    .filter(
      (r) =>
        account.openingDate === null || r.bookingDate >= account.openingDate,
    );
  return rows.length > 0 ? { count: rows.length } : null;
}

/** Turns on `fillFromTransfers` for an account and backfills its history. */
export function enableFill(userId: string, accountId: string): LinkResult {
  return getDB().transaction((tx) => {
    const account = loadPlanAccounts(userId, tx).find(
      (a) => a.id === accountId,
    );
    if (!account) throw notFound("Account");
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
    tx.update(accounts)
      .set({ fillFromTransfers: true })
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .run();
    return linkTransfers(userId, { targetAccountId: accountId }, tx);
  });
}

/** Number of mirrors on an account. */
export function countMirrors(userId: string, accountId: string): number {
  return (
    getDB()
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
          eq(transactions.source, "mirror"),
        ),
      )
      .get()?.n ?? 0
  );
}
