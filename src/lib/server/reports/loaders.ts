import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Minor, ShareBasis } from "$lib/money";
import { maskIban } from "$lib/iban";
import { getDB, securities, trades, transactions } from "$lib/server/db";
import { billViews } from "$lib/server/bills/status";
import { accountBalances } from "$lib/server/dashboard/accounts";
import { netWorthSeries } from "$lib/server/dashboard/net-worth";
import { getAccount } from "$lib/server/ledger/accounts";
import { accountBalanceAt, localToday } from "$lib/server/ledger/balances";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { addDays } from "$lib/server/dashboard/dates";
import type { BillsReportInput } from "./bills-report";
import { reconcileYear } from "$lib/server/tax/tax";
import type { NetWorthReportInput } from "./net-worth-report";
import { deductionSummary } from "$lib/server/tax/deductions";
import type { TaxDeductionsReportInput } from "./tax-deductions-report";
import type { TaxReportInput } from "./tax-report";
import type { AccountStatementInput, StatementTransaction } from "./statement";

/** A statement covers at most this many transactions; choose a shorter period otherwise. */
export const MAX_STATEMENT_TRANSACTIONS = 10_000;

export async function loadAccountStatement(
  userId: string,
  accountId: string,
  from: string,
  to: string,
  today: string = localToday(),
): Promise<AccountStatementInput> {
  if (from > to) {
    throw new LedgerError(
      "invalid",
      "The start date is after the end date.",
      "from",
    );
  }
  const account = await getAccount(userId, accountId, today);
  const where = and(
    eq(transactions.userId, userId),
    eq(transactions.accountId, accountId),
    gte(transactions.bookingDate, from),
    lte(transactions.bookingDate, to),
  );
  const db = getDB();
  const rows: StatementTransaction[] = await db
    .select({
      bookingDate: transactions.bookingDate,
      counterpartyName: transactions.counterpartyName,
      description: transactions.description,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(where)
    .orderBy(
      asc(transactions.bookingDate),
      asc(transactions.seq),
      asc(transactions.id),
    )
    .limit(MAX_STATEMENT_TRANSACTIONS + 1);
  if (account.tradesMoveCash) {
    // Buys and sells move the cash balance, so they are lines of the statement too.
    const moves = await db
      .select({
        date: trades.date,
        side: trades.side,
        amount: trades.amount,
        securityName: securities.name,
      })
      .from(trades)
      .innerJoin(securities, eq(securities.id, trades.securityId))
      .where(
        and(
          eq(trades.userId, userId),
          eq(trades.accountId, accountId),
          inArray(trades.side, ["buy", "sell"]),
          gte(trades.date, from),
          lte(trades.date, to),
        ),
      )
      .orderBy(asc(trades.date), asc(trades.seq), asc(trades.id))
      .limit(MAX_STATEMENT_TRANSACTIONS + 1);
    rows.push(
      ...moves.map((t): StatementTransaction => ({
        bookingDate: t.date,
        counterpartyName: null,
        description: `${t.side === "buy" ? "Buy" : "Sell"} ${t.securityName}`,
        amount: (t.side === "buy" ? -t.amount : t.amount) as Minor,
      })),
    );
    // Stable: on one day the booked rows stay ahead of the trades.
    rows.sort((x, y) => x.bookingDate.localeCompare(y.bookingDate));
  }
  if (rows.length > MAX_STATEMENT_TRANSACTIONS) {
    throw new LedgerError(
      "invalid",
      "Too many transactions in this period; choose a shorter one.",
      "from",
    );
  }
  return {
    account: {
      name: account.name,
      institutionName: account.institution?.name ?? null,
      ibanMasked: account.iban ? maskIban(account.iban) : null,
      currency: account.currency,
    },
    from,
    to,
    openingBalance: await accountBalanceAt(
      userId,
      accountId,
      addDays(from, -1),
    ),
    closingBalance: await accountBalanceAt(userId, accountId, to),
    transactions: rows,
    generatedOn: today,
  };
}

export async function loadBillsReport(
  userId: string,
  today: string = localToday(),
): Promise<BillsReportInput> {
  return { bills: await billViews(userId, { today }), asOf: today };
}

export async function loadNetWorthReport(
  userId: string,
  today: string = localToday(),
  basis: ShareBasis = "total",
): Promise<NetWorthReportInput> {
  return {
    series: await netWorthSeries(userId, { today, basis }),
    balances: (await accountBalances(userId, today)).map(
      ({ iban, ...balance }) => ({
        ...balance,
        ibanMasked: iban ? maskIban(iban) : null,
      }),
    ),
    asOf: today,
    basis,
  };
}

export async function loadTaxReport(
  userId: string,
  year: number,
  today: string = localToday(),
): Promise<TaxReportInput> {
  const reconciliation = await reconcileYear(userId, year);
  if (!reconciliation) throw notFound("Tax year");
  return { reconciliation, asOf: today };
}

export async function loadTaxDeductionsReport(
  userId: string,
  year: number,
  today: string = localToday(),
): Promise<TaxDeductionsReportInput> {
  return { summary: await deductionSummary(userId, year), asOf: today };
}
