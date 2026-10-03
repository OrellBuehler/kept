import { and, eq, lte, max } from "drizzle-orm";
import type { AccountType } from "$lib/ledger-types";
import { minor, type Minor } from "$lib/money";
import { balanceSnapshots, getDB } from "$lib/server/db";
import { listAccounts, type InstitutionRef } from "$lib/server/ledger/accounts";
import { localToday } from "$lib/server/ledger/balances";
import { daysBetween } from "./dates";

/** An account with imports is stale when its last import is older than this. */
export const IMPORT_STALE_DAYS = 45;
/** An account that was never imported is stale when its last snapshot is older than this. */
export const SNAPSHOT_STALE_DAYS = 120;

export interface AccountBalanceView {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  ibanMasked: string | null;
  institution: InstitutionRef | null;
  balance: Minor;
  lastBookingDate: string | null;
  /** Instant (ms since epoch) of the latest import, or null if never imported. */
  lastImportAt: number | null;
  lastSnapshotDate: string | null;
  stale: boolean;
  /** No import, snapshot or transaction yet: there is nothing to be stale. */
  noData: boolean;
  /**
   * Age in days of the data the stale flag is based on: the last import, or,
   * for accounts that were never imported, the last snapshot. Null when the
   * account has neither.
   */
  staleDays: number | null;
}

export interface CurrencyTotal {
  currency: string;
  balance: Minor;
  accountCount: number;
}

/** Non-archived accounts with their balance as of `today` and staleness. */
export function accountBalances(
  userId: string,
  today: string,
): AccountBalanceView[] {
  const lastSnapshot = new Map(
    getDB()
      .select({
        accountId: balanceSnapshots.accountId,
        d: max(balanceSnapshots.date),
      })
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.userId, userId),
          lte(balanceSnapshots.date, today),
        ),
      )
      .groupBy(balanceSnapshots.accountId)
      .all()
      .map((r) => [r.accountId, r.d]),
  );
  return listAccounts(userId, today)
    .filter((a) => !a.archived)
    .map((a) => {
      const lastSnapshotDate = lastSnapshot.get(a.id) ?? null;
      let staleDays: number | null = null;
      let stale = false;
      if (a.lastImportAt !== null) {
        staleDays = Math.max(
          0,
          daysBetween(localToday(new Date(a.lastImportAt)), today),
        );
        stale = staleDays > IMPORT_STALE_DAYS;
      } else if (lastSnapshotDate !== null) {
        staleDays = Math.max(0, daysBetween(lastSnapshotDate, today));
        stale = staleDays > SNAPSHOT_STALE_DAYS;
      }
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        currency: a.currency,
        ibanMasked: a.ibanMasked,
        institution: a.institution,
        balance: a.balance,
        lastBookingDate: a.lastBookingDate,
        lastImportAt: a.lastImportAt,
        lastSnapshotDate,
        stale,
        noData:
          a.lastImportAt === null &&
          lastSnapshotDate === null &&
          a.lastBookingDate === null,
        staleDays,
      };
    });
}

export function balanceTotals(
  accounts: readonly Pick<AccountBalanceView, "currency" | "balance">[],
): CurrencyTotal[] {
  const totals = new Map<string, { sum: number; n: number }>();
  for (const a of accounts) {
    const t = totals.get(a.currency) ?? { sum: 0, n: 0 };
    t.sum += a.balance;
    t.n += 1;
    totals.set(a.currency, t);
  }
  return [...totals.keys()].sort().map((currency) => ({
    currency,
    balance: minor(totals.get(currency)!.sum),
    accountCount: totals.get(currency)!.n,
  }));
}

export interface LastImportView {
  accountId: string;
  accountName: string;
  lastImportAt: number | null;
  lastBookingDate: string | null;
  stale: boolean;
  staleDays: number | null;
}

/** Per account: when it was last imported and whether it is stale. */
export function lastImports(
  userId: string,
  today: string,
  balances: readonly AccountBalanceView[] = accountBalances(userId, today),
): LastImportView[] {
  return balances.map((a) => ({
    accountId: a.id,
    accountName: a.name,
    lastImportAt: a.lastImportAt,
    lastBookingDate: a.lastBookingDate,
    stale: a.stale,
    staleDays: a.staleDays,
  }));
}
