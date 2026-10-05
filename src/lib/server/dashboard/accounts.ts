import { and, eq, lte, max } from "drizzle-orm";
import type { AccountType, WithdrawalPeriod } from "$lib/ledger-types";
import { minor, type Minor } from "$lib/money";
import { balanceSnapshots, getDB } from "$lib/server/db";
import { latestHoldingsActivity } from "$lib/server/investments/load";
import { latestPortfolioValueDates } from "$lib/server/pillar3a/load";
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
  iban: string | null;
  contractNumber: string | null;
  depositIban: string | null;
  institution: InstitutionRef | null;
  balance: Minor;
  /** `balance` without the value of holdings and portfolios. */
  cashBalance: Minor;
  /** Securities held through trades (account currency); null without trades. */
  holdings: { value: Minor; cost: Minor; estimated: boolean } | null;
  noticeMonths: number | null;
  freeWithdrawal: Minor | null;
  freeWithdrawalPeriod: WithdrawalPeriod | null;
  shareBps: number;
  sharedWith: string | null;
  /** `balance` at the ownership share. */
  shareBalance: Minor;
  lastBookingDate: string | null;
  /** Instant (ms since epoch) of the latest import, or null if never imported. */
  lastImportAt: number | null;
  lastSnapshotDate: string | null;
  /** Pillar 3a: the date of the newest manually entered portfolio value. */
  lastPortfolioValueDate: string | null;
  stale: boolean;
  /** No import, snapshot or transaction yet: there is nothing to be stale. */
  noData: boolean;
  /**
   * Age in days of the data the stale flag is based on: the last import, or,
   * for accounts that were never imported, the last snapshot or portfolio
   * value (whichever is newer). Recent holdings activity (a trade or a manual
   * price of a held security; fetched prices do not count) takes over when it
   * clears staleness or when there is neither. Null when the account has none
   * of these.
   */
  staleDays: number | null;
}

export interface CurrencyTotal {
  currency: string;
  balance: Minor;
  /** Sum of the balances at each account's ownership share. */
  shareBalance: Minor;
  accountCount: number;
}

/** Non-archived accounts with their balance as of `today` and staleness. */
export async function accountBalances(
  userId: string,
  today: string,
): Promise<AccountBalanceView[]> {
  const lastSnapshot = new Map(
    (
      await getDB()
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
    ).map((r) => [r.accountId, r.d]),
  );
  const accountRows = (await listAccounts(userId, today)).filter(
    (a) => !a.archived,
  );
  const holdingsActivity = await latestHoldingsActivity(
    userId,
    accountRows.map((a) => a.id),
    today,
  );
  const portfolioValueDates = await latestPortfolioValueDates(
    userId,
    accountRows.map((a) => a.id),
    today,
  );
  return accountRows.map((a) => {
    const lastSnapshotDate = lastSnapshot.get(a.id) ?? null;
    const lastPortfolioValueDate = portfolioValueDates.get(a.id) ?? null;
    // A manually entered portfolio value is as good as a manual snapshot.
    const lastBalanceDate =
      lastPortfolioValueDate !== null &&
      (lastSnapshotDate === null || lastPortfolioValueDate > lastSnapshotDate)
        ? lastPortfolioValueDate
        : lastSnapshotDate;
    let staleDays: number | null = null;
    let stale = false;
    if (a.lastImportAt !== null) {
      staleDays = Math.max(
        0,
        daysBetween(localToday(new Date(a.lastImportAt)), today),
      );
      stale = staleDays > IMPORT_STALE_DAYS;
    } else if (lastBalanceDate !== null) {
      staleDays = Math.max(0, daysBetween(lastBalanceDate, today));
      stale = staleDays > SNAPSHOT_STALE_DAYS;
    }
    const activity = holdingsActivity.get(a.id) ?? null;
    if (activity !== null) {
      const age = Math.max(0, daysBetween(activity, today));
      if (staleDays === null) {
        staleDays = age;
        stale = age > IMPORT_STALE_DAYS;
      } else if (stale && age <= IMPORT_STALE_DAYS) {
        staleDays = age;
        stale = false;
      }
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      iban: a.iban,
      contractNumber: a.contractNumber,
      depositIban: a.depositIban,
      institution: a.institution,
      balance: a.balance,
      cashBalance: a.cashBalance,
      holdings: a.holdings,
      noticeMonths: a.noticeMonths,
      freeWithdrawal: a.freeWithdrawal,
      freeWithdrawalPeriod: a.freeWithdrawalPeriod,
      shareBps: a.shareBps,
      sharedWith: a.sharedWith,
      shareBalance: a.shareBalance,
      lastBookingDate: a.lastBookingDate,
      lastImportAt: a.lastImportAt,
      lastSnapshotDate,
      lastPortfolioValueDate,
      stale,
      noData:
        a.lastImportAt === null &&
        lastSnapshotDate === null &&
        lastPortfolioValueDate === null &&
        a.lastBookingDate === null &&
        activity === null,
      staleDays,
    };
  });
}

export function balanceTotals(
  accounts: readonly Pick<
    AccountBalanceView,
    "currency" | "balance" | "shareBalance"
  >[],
): CurrencyTotal[] {
  const totals = new Map<string, { sum: number; share: number; n: number }>();
  for (const a of accounts) {
    const t = totals.get(a.currency) ?? { sum: 0, share: 0, n: 0 };
    t.sum += a.balance;
    t.share += a.shareBalance;
    t.n += 1;
    totals.set(a.currency, t);
  }
  return [...totals.keys()].sort().map((currency) => ({
    currency,
    balance: minor(totals.get(currency)!.sum),
    shareBalance: minor(totals.get(currency)!.share),
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
export async function lastImports(
  userId: string,
  today: string,
  balances?: readonly AccountBalanceView[],
): Promise<LastImportView[]> {
  const rows = balances ?? (await accountBalances(userId, today));
  return rows.map((a) => ({
    accountId: a.id,
    accountName: a.name,
    lastImportAt: a.lastImportAt,
    lastBookingDate: a.lastBookingDate,
    stale: a.stale,
    staleDays: a.staleDays,
  }));
}
