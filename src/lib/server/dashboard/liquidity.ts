import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AccountType } from "$lib/ledger-types";
import { minor, shareOf, type Minor } from "$lib/money";
import { getDB, transactions } from "$lib/server/db";
import { getPreferences } from "$lib/server/preferences";
import { accountBalances, type AccountBalanceView } from "./accounts";
import { addMonths } from "./dates";

/**
 * How an account type counts towards liquid cash.
 * - liquid: its cash balance is available now, unless a notice period is set.
 * - debt: the balance is added as is, so outstanding debt reduces liquid cash.
 * - investment: only the cash part, and only when the user opts in; securities never.
 * - excluded: never liquid (pension and pillar 3a).
 */
const LIQUIDITY_CLASS = {
  current: "liquid",
  cash: "liquid",
  savings: "liquid",
  other: "liquid",
  credit_card: "debt",
  investment: "investment",
  pension: "excluded",
  pillar_3a: "excluded",
} as const satisfies Record<AccountType, string>;

export type LiquidityAccount = Pick<
  AccountBalanceView,
  | "id"
  | "name"
  | "type"
  | "currency"
  | "shareBps"
  | "balance"
  | "cashBalance"
  | "noticeMonths"
  | "freeWithdrawal"
  | "freeWithdrawalPeriod"
>;

export interface LiquidityOptions {
  today: string;
  investmentCashLiquid: boolean;
  /** Amount withdrawn this month / this year per notice account (positive, account currency). */
  usedThisPeriod: ReadonlyMap<string, number>;
}

export interface LiquidityAmount {
  balance: Minor;
  /** `balance` at the ownership share. */
  shareBalance: Minor;
}

export interface LadderStep extends LiquidityAmount {
  months: number;
  /** `today` plus `months`, assuming notice is given today. */
  availableFrom: string;
  accounts: { id: string; name: string }[];
}

export interface ExcludedTotal extends LiquidityAmount {
  /** "pension" covers pension and pillar 3a accounts. */
  reason: "pension" | "investment_cash";
  accountCount: number;
}

export interface CurrencyLiquidity {
  currency: string;
  /** Available now: cash, free withdrawal allowances and card debt (negative). */
  now: LiquidityAmount;
  /** Money behind a notice period, one step per distinct period, soonest first. */
  ladder: LadderStep[];
  /** What is left out of the figures above. */
  excluded: ExcludedTotal[];
}

interface Bucket {
  now: number;
  shareNow: number;
  ladder: Map<
    number,
    { balance: number; share: number; accounts: { id: string; name: string }[] }
  >;
  excluded: Map<
    ExcludedTotal["reason"],
    { balance: number; share: number; n: number }
  >;
}

export function computeLiquidity(
  accounts: readonly LiquidityAccount[],
  options: LiquidityOptions,
): CurrencyLiquidity[] {
  const buckets = new Map<string, Bucket>();
  const bucketOf = (currency: string): Bucket => {
    let b = buckets.get(currency);
    if (!b) {
      b = { now: 0, shareNow: 0, ladder: new Map(), excluded: new Map() };
      buckets.set(currency, b);
    }
    return b;
  };
  const exclude = (
    b: Bucket,
    reason: ExcludedTotal["reason"],
    balance: Minor,
    shareBps: number,
  ) => {
    const e = b.excluded.get(reason) ?? { balance: 0, share: 0, n: 0 };
    e.balance += balance;
    e.share += shareOf(balance, shareBps);
    e.n += 1;
    b.excluded.set(reason, e);
  };

  for (const a of accounts) {
    const b = bucketOf(a.currency);
    switch (LIQUIDITY_CLASS[a.type]) {
      case "excluded":
        exclude(b, "pension", a.balance, a.shareBps);
        break;
      case "debt":
        b.now += a.cashBalance;
        b.shareNow += shareOf(a.cashBalance, a.shareBps);
        break;
      case "investment":
        if (options.investmentCashLiquid) {
          b.now += a.cashBalance;
          b.shareNow += shareOf(a.cashBalance, a.shareBps);
        } else {
          exclude(b, "investment_cash", a.cashBalance, a.shareBps);
        }
        break;
      case "liquid": {
        if (a.noticeMonths === null) {
          b.now += a.cashBalance;
          b.shareNow += shareOf(a.cashBalance, a.shareBps);
          break;
        }
        // An overdrawn notice account is a debt like a card balance.
        const positive = Math.max(a.cashBalance, 0);
        const free = Math.min(
          positive,
          Math.max(
            (a.freeWithdrawal ?? 0) - (options.usedThisPeriod.get(a.id) ?? 0),
            0,
          ),
        );
        const debt = a.cashBalance - positive;
        const shareFree = shareOf(minor(free), a.shareBps);
        b.now += free + debt;
        b.shareNow += shareFree + shareOf(minor(debt), a.shareBps);
        const rest = positive - free;
        if (rest > 0) {
          const step = b.ladder.get(a.noticeMonths) ?? {
            balance: 0,
            share: 0,
            accounts: [],
          };
          step.balance += rest;
          step.share += shareOf(minor(positive), a.shareBps) - shareFree;
          step.accounts.push({ id: a.id, name: a.name });
          b.ladder.set(a.noticeMonths, step);
        }
        break;
      }
    }
  }

  return [...buckets.keys()].sort().flatMap((currency) => {
    const b = buckets.get(currency)!;
    const excluded = [...b.excluded.entries()]
      .filter(([, e]) => e.balance !== 0 || e.share !== 0)
      .map(([reason, e]) => ({
        reason,
        balance: minor(e.balance),
        shareBalance: minor(e.share),
        accountCount: e.n,
      }))
      .sort((x, y) => x.reason.localeCompare(y.reason));
    // Nothing to show: no spendable money, no ladder, nothing to footnote.
    if (
      b.now === 0 &&
      b.shareNow === 0 &&
      b.ladder.size === 0 &&
      excluded.length === 0
    ) {
      return [];
    }
    return [
      {
        currency,
        now: { balance: minor(b.now), shareBalance: minor(b.shareNow) },
        ladder: [...b.ladder.keys()]
          .sort((x, y) => x - y)
          .map((months) => {
            const step = b.ladder.get(months)!;
            return {
              months,
              availableFrom: addMonths(options.today, months),
              balance: minor(step.balance),
              shareBalance: minor(step.share),
              accounts: step.accounts,
            };
          }),
        excluded,
      },
    ];
  });
}

/**
 * Per notice account: what was withdrawn (debits) in the current calendar
 * month or year, depending on its free-withdrawal period, up to `today`.
 */
export function withdrawnThisPeriod(
  userId: string,
  accounts: readonly Pick<
    LiquidityAccount,
    "id" | "noticeMonths" | "freeWithdrawalPeriod"
  >[],
  today: string,
): Map<string, number> {
  const notice = accounts.filter(
    (a) => a.noticeMonths !== null && a.freeWithdrawalPeriod !== null,
  );
  const used = new Map<string, number>();
  if (notice.length === 0) return used;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const monthStart = `${today.slice(0, 7)}-01`;
  // Only debits count, and only within the current calendar month or year (not
  // a rolling window), matching how banks usually reset free withdrawals.
  const debit = sql`case when ${transactions.amount} < 0 then -${transactions.amount} else 0 end`;
  const rows = getDB()
    .select({
      accountId: transactions.accountId,
      year: sql<number>`coalesce(sum(${debit}), 0)`,
      month: sql<number>`coalesce(sum(case when ${transactions.bookingDate} >= ${monthStart} then ${debit} else 0 end), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(
          transactions.accountId,
          notice.map((a) => a.id),
        ),
        gte(transactions.bookingDate, yearStart),
        lte(transactions.bookingDate, today),
      ),
    )
    .groupBy(transactions.accountId)
    .all();
  const period = new Map(notice.map((a) => [a.id, a.freeWithdrawalPeriod]));
  for (const r of rows) {
    used.set(
      r.accountId,
      period.get(r.accountId) === "year" ? r.year : r.month,
    );
  }
  return used;
}

/** Liquid cash and the notice ladder at the ownership share (see `computeLiquidity`). */
export async function liquidity(
  userId: string,
  today: string,
  balances?: readonly AccountBalanceView[],
  investmentCashLiquid: boolean = getPreferences(userId).investmentCashLiquid,
): Promise<CurrencyLiquidity[]> {
  const accounts = balances ?? (await accountBalances(userId, today));
  return computeLiquidity(accounts, {
    today,
    investmentCashLiquid,
    usedThisPeriod: withdrawnThisPeriod(userId, accounts, today),
  });
}
