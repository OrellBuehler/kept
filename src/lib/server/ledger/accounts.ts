import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { AccountType, WithdrawalPeriod } from "$lib/ledger-types";
import { shareOf, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  imports,
  institutions,
  portfolios,
  trades,
  transactions,
} from "$lib/server/db";
import { assertReferenceFits } from "$lib/server/pillar3a/portfolios";
import { linkTransfers, removeMirrors } from "$lib/server/transfers";
import { currentValues, type CurrentValue } from "./balances";
import { LedgerError, notFound } from "./errors";
import type { AccountInput } from "./schemas";

export interface InstitutionRef {
  id: string;
  name: string;
  color: string | null;
  logoVersion: string | null;
}

export interface AccountView {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  iban: string | null;
  /** Pillar 3a: the provider's contract number. */
  contractNumber: string | null;
  /** Pillar 3a: the IBAN (usually a QR-IBAN) payments go to. */
  depositIban: string | null;
  openingBalance: Minor;
  openingDate: string | null;
  /** Months of notice before the balance can be withdrawn; null means available now. */
  noticeMonths: number | null;
  /** Amount withdrawable without notice per period, account currency; needs `noticeMonths`. */
  freeWithdrawal: Minor | null;
  freeWithdrawalPeriod: WithdrawalPeriod | null;
  /** Kept creates the counter-transaction here when another account shows a transfer to this IBAN. */
  fillFromTransfers: boolean;
  /** Buys reduce and sells increase the cash balance (accounts without statements). */
  tradesMoveCash: boolean;
  archived: boolean;
  sortOrder: number;
  /** Ownership share in basis points (10000 = 100%); stored amounts are always 100%. */
  shareBps: number;
  sharedWith: string | null;
  institution: InstitutionRef | null;
  /** Latest known balance in the account currency (see balances.ts). */
  balance: Minor;
  /** `balance` without the value of holdings. */
  cashBalance: Minor;
  /** Securities held through trades (account currency); null without trades. */
  holdings: { value: Minor; cost: Minor; estimated: boolean } | null;
  /** `balance` at the ownership share. */
  shareBalance: Minor;
  lastBookingDate: string | null;
  /** Instant (ms since epoch) of the most recent import, or null. */
  lastImportAt: number | null;
}

function baseRows(userId: string, accountId?: string) {
  return getDB()
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      currency: accounts.currency,
      iban: accounts.iban,
      contractNumber: accounts.contractNumber,
      depositIban: accounts.depositIban,
      openingBalance: accounts.openingBalance,
      openingDate: accounts.openingDate,
      noticeMonths: accounts.noticeMonths,
      freeWithdrawal: accounts.freeWithdrawal,
      freeWithdrawalPeriod: accounts.freeWithdrawalPeriod,
      fillFromTransfers: accounts.fillFromTransfers,
      tradesMoveCash: accounts.tradesMoveCash,
      archived: accounts.archived,
      sortOrder: accounts.sortOrder,
      shareBps: accounts.shareBps,
      sharedWith: accounts.sharedWith,
      institutionId: institutions.id,
      institutionName: institutions.name,
      institutionColor: institutions.color,
      institutionLogoVersion: institutions.logoVersion,
    })
    .from(accounts)
    .leftJoin(institutions, eq(institutions.id, accounts.institutionId))
    .where(
      and(
        eq(accounts.userId, userId),
        accountId ? eq(accounts.id, accountId) : undefined,
      ),
    )
    .orderBy(asc(accounts.sortOrder), asc(accounts.name), asc(accounts.id))
    .all();
}

function holdingsOf(held: CurrentValue["holdings"]): AccountView["holdings"] {
  return held
    ? { value: held.value, cost: held.cost, estimated: held.estimated }
    : null;
}

function toViews(
  userId: string,
  accountId?: string,
  today?: string,
): AccountView[] {
  const db = getDB();
  const lastBooking = new Map(
    db
      .select({
        id: transactions.accountId,
        d: sql<string>`max(${transactions.bookingDate})`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          accountId ? eq(transactions.accountId, accountId) : undefined,
        ),
      )
      .groupBy(transactions.accountId)
      .all()
      .map((r) => [r.id, r.d]),
  );
  const lastImport = new Map(
    db
      .select({
        id: imports.accountId,
        t: sql<number>`max(${imports.createdAt})`,
      })
      .from(imports)
      .where(
        and(
          eq(imports.userId, userId),
          accountId ? eq(imports.accountId, accountId) : undefined,
        ),
      )
      .groupBy(imports.accountId)
      .all()
      .map((r) => [r.id, r.t]),
  );
  const rows = baseRows(userId, accountId);
  const values = currentValues(userId, rows, today);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    currency: r.currency,
    iban: r.iban,
    contractNumber: r.contractNumber,
    depositIban: r.depositIban,
    openingBalance: r.openingBalance,
    openingDate: r.openingDate,
    noticeMonths: r.noticeMonths,
    freeWithdrawal: r.freeWithdrawal,
    freeWithdrawalPeriod: r.freeWithdrawalPeriod,
    fillFromTransfers: r.fillFromTransfers,
    tradesMoveCash: r.tradesMoveCash,
    archived: r.archived,
    sortOrder: r.sortOrder,
    shareBps: r.shareBps,
    sharedWith: r.sharedWith,
    institution: r.institutionId
      ? {
          id: r.institutionId,
          name: r.institutionName!,
          color: r.institutionColor,
          logoVersion: r.institutionLogoVersion,
        }
      : null,
    balance: values.get(r.id)!.total,
    cashBalance: values.get(r.id)!.cash,
    holdings: holdingsOf(values.get(r.id)!.holdings),
    shareBalance: shareOf(values.get(r.id)!.total, r.shareBps),
    lastBookingDate: lastBooking.get(r.id) ?? null,
    lastImportAt: lastImport.get(r.id) ?? null,
  }));
}

export function listAccounts(userId: string, today?: string): AccountView[] {
  return toViews(userId, undefined, today);
}

export function getAccount(
  userId: string,
  id: string,
  today?: string,
): AccountView {
  const found = toViews(userId, id, today)[0];
  if (!found) throw notFound("Account");
  return found;
}

function assertInstitutionOwned(userId: string, institutionId: string | null) {
  if (institutionId === null) return;
  const found = getDB()
    .select({ id: institutions.id })
    .from(institutions)
    .where(
      and(eq(institutions.userId, userId), eq(institutions.id, institutionId)),
    )
    .get();
  if (!found) {
    throw new LedgerError("invalid", "Unknown institution.", "institutionId");
  }
}

function assertIbanFree(
  userId: string,
  iban: string | null,
  exceptId?: string,
) {
  if (iban === null) return;
  const clash = getDB()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.iban, iban),
        exceptId ? ne(accounts.id, exceptId) : undefined,
      ),
    )
    .get();
  if (clash) {
    throw new LedgerError(
      "conflict",
      "Another account already uses this IBAN.",
      "iban",
    );
  }
}

export function createAccount(
  userId: string,
  input: AccountInput,
): AccountView {
  assertInstitutionOwned(userId, input.institutionId);
  assertIbanFree(userId, input.iban);
  const db = getDB();
  const sortOrder =
    input.sortOrder ??
    (db
      .select({ m: sql<number | null>`max(${accounts.sortOrder})` })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .get()?.m ?? -1) + 1;
  const row = db.transaction((tx) => {
    const created = tx
      .insert(accounts)
      .values({
        ...input,
        sortOrder,
        userId,
        fillFromTransfers:
          input.fillFromTransfers && input.type !== "pillar_3a",
        tradesMoveCash: input.tradesMoveCash && input.type === "investment",
      })
      .returning({ id: accounts.id })
      .get();
    // Transfers other accounts already show to this IBAN become mirrors here.
    if (input.fillFromTransfers && input.type !== "pillar_3a") {
      linkTransfers(userId, { targetAccountId: created.id }, tx);
    }
    return created;
  });
  return getAccount(userId, row.id);
}

export function updateAccount(
  userId: string,
  id: string,
  input: AccountInput,
): AccountView {
  const current = getAccount(userId, id);
  assertInstitutionOwned(userId, input.institutionId);
  assertIbanFree(userId, input.iban, id);

  const db = getDB();
  const portfolioRows = db
    .select({ reference: portfolios.depositReference })
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.accountId, id)))
    .all();
  if (input.type !== "pillar_3a" && portfolioRows.length > 0) {
    throw new LedgerError(
      "conflict",
      "The type cannot change while the account has portfolios.",
      "type",
    );
  }
  if (input.depositIban !== current.depositIban) {
    for (const p of portfolioRows) {
      try {
        assertReferenceFits(input.depositIban, p.reference);
      } catch (err) {
        if (err instanceof LedgerError) {
          throw new LedgerError(
            "invalid",
            "A portfolio reference no longer fits the new deposit IBAN.",
            "depositIban",
          );
        }
        throw err;
      }
    }
  }

  if (input.currency !== current.currency) {
    const used =
      db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.accountId, id))
        .get() ??
      db
        .select({ id: balanceSnapshots.id })
        .from(balanceSnapshots)
        .where(eq(balanceSnapshots.accountId, id))
        .get() ??
      db
        .select({ id: trades.id })
        .from(trades)
        .where(eq(trades.accountId, id))
        .get() ??
      (portfolioRows.length > 0 ? true : undefined) ??
      // The same non-zero opening balance would silently turn into another currency.
      (current.openingBalance !== 0 &&
      input.openingBalance === current.openingBalance
        ? true
        : undefined);
    if (used) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the account has transactions, balances, trades, portfolio values or an opening balance. Set the opening balance to zero first.",
        "currency",
      );
    }
  }

  const { sortOrder, ...rest } = input;
  const hasTrades =
    db
      .select({ id: trades.id })
      .from(trades)
      .where(eq(trades.accountId, id))
      .get() !== undefined;
  const fillFromTransfers =
    rest.fillFromTransfers &&
    rest.type !== "pillar_3a" &&
    portfolioRows.length === 0;
  const tradesMoveCash =
    rest.tradesMoveCash && (rest.type === "investment" || hasTrades);
  const ibanChanged = rest.iban !== current.iban;
  db.transaction((tx) => {
    tx.update(accounts)
      .set({
        ...rest,
        fillFromTransfers,
        tradesMoveCash,
        sortOrder: sortOrder ?? current.sortOrder,
      })
      .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
      .run();
    if (current.fillFromTransfers && !fillFromTransfers) {
      removeMirrors(userId, id, tx);
    }
    if (ibanChanged || rest.name !== current.name) {
      // Mirrors created from this account's rows name it as their counterparty.
      tx.update(transactions)
        .set({ counterpartyName: rest.name, counterpartyIban: rest.iban })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.source, "mirror"),
            inArray(
              transactions.mirrorOfId,
              tx
                .select({ id: transactions.id })
                .from(transactions)
                .where(eq(transactions.accountId, id)),
            ),
          ),
        )
        .run();
    }
    if (
      (fillFromTransfers && !current.fillFromTransfers) ||
      (ibanChanged && rest.iban !== null)
    ) {
      linkTransfers(userId, { targetAccountId: id }, tx);
    }
  });
  return getAccount(userId, id);
}

export function setAccountArchived(
  userId: string,
  id: string,
  archived: boolean,
): AccountView {
  getAccount(userId, id);
  getDB()
    .update(accounts)
    .set({ archived, archivedAt: archived ? new Date() : null })
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
    .run();
  return getAccount(userId, id);
}

export const archiveAccount = (userId: string, id: string) =>
  setAccountArchived(userId, id, true);
export const unarchiveAccount = (userId: string, id: string) =>
  setAccountArchived(userId, id, false);

/** Hard delete; transactions, imports, snapshots and the CSV profile cascade. */
export function deleteAccount(userId: string, id: string): void {
  getAccount(userId, id);
  getDB()
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
    .run();
}
