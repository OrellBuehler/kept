import { and, asc, eq, inArray, max, ne, sql } from "drizzle-orm";
import type { AccountType, WithdrawalPeriod } from "$lib/ledger-types";
import { shareOf, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  imports,
  institutions,
  isUniqueViolation,
  portfolios,
  trades,
  transactions,
  type DB,
  first,
  transaction,
} from "$lib/server/db";
import { assertReferenceFits } from "$lib/server/pillar3a/portfolios";
import {
  countMirrorsInTx,
  linkTransfersInTx,
  removeMirrors,
  revalidateLinks,
  transfersLock,
  type Tx,
} from "$lib/server/transfers";
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

async function baseRows(userId: string, accountId?: string) {
  return await getDB()
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
    .orderBy(asc(accounts.sortOrder), asc(accounts.name), asc(accounts.id));
}

function holdingsOf(held: CurrentValue["holdings"]): AccountView["holdings"] {
  return held
    ? { value: held.value, cost: held.cost, estimated: held.estimated }
    : null;
}

async function toViews(
  userId: string,
  accountId?: string,
  today?: string,
): Promise<AccountView[]> {
  const db = getDB();
  const lastBooking = new Map(
    (
      await db
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
    ).map((r) => [r.id, r.d]),
  );
  const lastImport = new Map(
    (
      await db
        .select({
          id: imports.accountId,
          t: max(imports.createdAt),
        })
        .from(imports)
        .where(
          and(
            eq(imports.userId, userId),
            accountId ? eq(imports.accountId, accountId) : undefined,
          ),
        )
        .groupBy(imports.accountId)
    ).map((r) => [r.id, r.t?.getTime() ?? null]),
  );
  const rows = await baseRows(userId, accountId);
  const values = await currentValues(userId, rows, today);
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

export async function listAccounts(
  userId: string,
  today?: string,
): Promise<AccountView[]> {
  return await toViews(userId, undefined, today);
}

export async function getAccount(
  userId: string,
  id: string,
  today?: string,
): Promise<AccountView> {
  const found = (await toViews(userId, id, today))[0];
  if (!found) throw notFound("Account");
  return found;
}

type Reader = Pick<DB, "select">;

/** Runs inside the transaction of createAccount / updateAccount. */
async function assertInstitutionOwned(
  tx: Reader,
  userId: string,
  institutionId: string | null,
) {
  if (institutionId === null) return;
  const found = await first(
    tx
      .select({ id: institutions.id })
      .from(institutions)
      .where(
        and(
          eq(institutions.userId, userId),
          eq(institutions.id, institutionId),
        ),
      )
      .limit(1),
  );
  if (!found) {
    throw new LedgerError("invalid", "Unknown institution.", "institutionId");
  }
}

const ibanTaken = () =>
  new LedgerError(
    "conflict",
    "Another account already uses this IBAN.",
    "iban",
  );

/** Runs inside the transaction of createAccount / updateAccount. */
async function assertIbanFree(
  tx: Reader,
  userId: string,
  iban: string | null,
  exceptId?: string,
) {
  if (iban === null) return;
  const clash = await first(
    tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.iban, iban),
          exceptId ? ne(accounts.id, exceptId) : undefined,
        ),
      )
      .limit(1),
  );
  if (clash) throw ibanTaken();
}

/**
 * The in-transaction IBAN check is the friendly path; the unique index on
 * (user, iban) is the backstop when two writes race, and maps to the same error.
 */
function mapIbanViolation(err: unknown, iban: string | null): never {
  if (iban !== null && isUniqueViolation(err)) throw ibanTaken();
  throw err;
}

export async function createAccount(
  userId: string,
  input: AccountInput,
): Promise<AccountView> {
  let id: string;
  try {
    id = await transaction(
      async (tx) => {
        await assertInstitutionOwned(tx, userId, input.institutionId);
        await assertIbanFree(tx, userId, input.iban);
        const sortOrder =
          input.sortOrder ??
          ((
            await first(
              tx
                .select({
                  m: sql<number | null>`max(${accounts.sortOrder})`.mapWith(
                    Number,
                  ),
                })
                .from(accounts)
                .where(eq(accounts.userId, userId))
                .limit(1),
            )
          )?.m ?? -1) + 1;
        const created = (await first(
          tx
            .insert(accounts)
            .values({
              ...input,
              sortOrder,
              userId,
              fillFromTransfers:
                input.fillFromTransfers === true && input.type !== "pillar_3a",
              tradesMoveCash:
                input.tradesMoveCash && input.type === "investment",
            })
            .returning({ id: accounts.id }),
        ))!;
        // Transfers other accounts already show to this IBAN become mirrors here.
        if (input.fillFromTransfers === true && input.type !== "pillar_3a") {
          await linkTransfersInTx(tx, userId, { targetAccountId: created.id });
        }
        return created.id;
      },
      { lock: transfersLock(userId) },
    );
  } catch (err) {
    mapIbanViolation(err, input.iban);
  }
  return await getAccount(userId, id);
}

/** The body of updateAccount's transaction, so the checks and the writes are one unit. */
async function updateAccountInTx(
  tx: Tx,
  userId: string,
  id: string,
  input: AccountInput & { confirmRemoveMirrors?: boolean },
): Promise<void> {
  const current = await first(
    tx
      .select({
        name: accounts.name,
        iban: accounts.iban,
        currency: accounts.currency,
        depositIban: accounts.depositIban,
        openingBalance: accounts.openingBalance,
        fillFromTransfers: accounts.fillFromTransfers,
        sortOrder: accounts.sortOrder,
      })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
      .limit(1),
  );
  if (!current) throw notFound("Account");
  await assertInstitutionOwned(tx, userId, input.institutionId);
  await assertIbanFree(tx, userId, input.iban, id);

  const portfolioRows = await tx
    .select({ reference: portfolios.depositReference })
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.accountId, id)));
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
      (await first(
        tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.accountId, id))
          .limit(1),
      )) ??
      (await first(
        tx
          .select({ id: balanceSnapshots.id })
          .from(balanceSnapshots)
          .where(eq(balanceSnapshots.accountId, id))
          .limit(1),
      )) ??
      (await first(
        tx
          .select({ id: trades.id })
          .from(trades)
          .where(eq(trades.accountId, id))
          .limit(1),
      )) ??
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

  const { sortOrder, confirmRemoveMirrors, ...rest } = input;
  const hasTrades =
    (await first(
      tx
        .select({ id: trades.id })
        .from(trades)
        .where(eq(trades.accountId, id))
        .limit(1),
    )) !== undefined;
  const fillFromTransfers =
    (rest.fillFromTransfers ?? current.fillFromTransfers) &&
    rest.type !== "pillar_3a" &&
    portfolioRows.length === 0;
  if (
    current.fillFromTransfers &&
    rest.fillFromTransfers === false &&
    !confirmRemoveMirrors &&
    (await countMirrorsInTx(tx, userId, id)) > 0
  ) {
    throw new LedgerError(
      "invalid",
      "Turning this off deletes the transactions Kept created from transfers. Confirm to continue.",
      "fillFromTransfers",
    );
  }
  const tradesMoveCash =
    rest.tradesMoveCash && (rest.type === "investment" || hasTrades);
  const ibanChanged = rest.iban !== current.iban;
  await tx
    .update(accounts)
    .set({
      ...rest,
      fillFromTransfers,
      tradesMoveCash,
      sortOrder: sortOrder ?? current.sortOrder,
    })
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
  if (current.fillFromTransfers && !fillFromTransfers) {
    await removeMirrors(tx, userId, id);
  }
  if (ibanChanged || rest.name !== current.name) {
    // Mirrors created from this account's rows name it as their counterparty.
    await tx
      .update(transactions)
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
      );
  }
  // Links that depended on the old IBAN go before the new one links anything.
  if (ibanChanged) await revalidateLinks(tx, userId, id);
  if (
    (fillFromTransfers && !current.fillFromTransfers) ||
    (ibanChanged && rest.iban !== null)
  ) {
    await linkTransfersInTx(tx, userId, { targetAccountId: id });
  }
}

export async function updateAccount(
  userId: string,
  id: string,
  input: AccountInput & { confirmRemoveMirrors?: boolean },
): Promise<AccountView> {
  try {
    await transaction(async (tx) => updateAccountInTx(tx, userId, id, input), {
      lock: transfersLock(userId),
    });
  } catch (err) {
    mapIbanViolation(err, input.iban);
  }
  return await getAccount(userId, id);
}

export async function setAccountArchived(
  userId: string,
  id: string,
  archived: boolean,
): Promise<AccountView> {
  await getAccount(userId, id);
  await getDB()
    .update(accounts)
    .set({ archived, archivedAt: archived ? new Date() : null })
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
  return await getAccount(userId, id);
}

export const archiveAccount = async (userId: string, id: string) =>
  await setAccountArchived(userId, id, true);
export const unarchiveAccount = async (userId: string, id: string) =>
  await setAccountArchived(userId, id, false);

/** Hard delete; transactions, imports, snapshots and the CSV profile cascade. */
export async function deleteAccount(userId: string, id: string): Promise<void> {
  await getAccount(userId, id);
  await getDB()
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)));
}
