import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { AccountType } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  imports,
  institutions,
  transactions,
} from "$lib/server/db";
import { currentBalances } from "./balances";
import { LedgerError, notFound } from "./errors";
import { maskIban } from "$lib/iban";
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
  ibanMasked: string | null;
  openingBalance: Minor;
  openingDate: string | null;
  archived: boolean;
  sortOrder: number;
  institution: InstitutionRef | null;
  /** Latest known balance in the account currency (see balances.ts). */
  balance: Minor;
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
      openingBalance: accounts.openingBalance,
      openingDate: accounts.openingDate,
      archived: accounts.archived,
      sortOrder: accounts.sortOrder,
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
  const balances = currentBalances(userId, rows, today);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    currency: r.currency,
    iban: r.iban,
    ibanMasked: r.iban ? maskIban(r.iban) : null,
    openingBalance: r.openingBalance,
    openingDate: r.openingDate,
    archived: r.archived,
    sortOrder: r.sortOrder,
    institution: r.institutionId
      ? {
          id: r.institutionId,
          name: r.institutionName!,
          color: r.institutionColor,
          logoVersion: r.institutionLogoVersion,
        }
      : null,
    balance: balances.get(r.id)!,
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
  const row = db
    .insert(accounts)
    .values({ ...input, sortOrder, userId })
    .returning({ id: accounts.id })
    .get();
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

  if (input.currency !== current.currency) {
    const db = getDB();
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
        .get();
    if (used) {
      throw new LedgerError(
        "conflict",
        "The currency cannot change while the account has transactions or balances.",
        "currency",
      );
    }
  }

  const { sortOrder, ...rest } = input;
  getDB()
    .update(accounts)
    .set({ ...rest, sortOrder: sortOrder ?? current.sortOrder })
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
    .run();
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
    .set({ archived })
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
