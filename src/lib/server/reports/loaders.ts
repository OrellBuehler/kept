import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { ShareBasis } from "$lib/money";
import { maskIban } from "$lib/iban";
import { getDB, transactions } from "$lib/server/db";
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
import type { AccountStatementInput } from "./statement";

/** A statement covers at most this many transactions; choose a shorter period otherwise. */
export const MAX_STATEMENT_TRANSACTIONS = 10_000;

export function loadAccountStatement(
  userId: string,
  accountId: string,
  from: string,
  to: string,
  today: string = localToday(),
): AccountStatementInput {
  if (from > to) {
    throw new LedgerError(
      "invalid",
      "The start date is after the end date.",
      "from",
    );
  }
  const account = getAccount(userId, accountId, today);
  const where = and(
    eq(transactions.userId, userId),
    eq(transactions.accountId, accountId),
    gte(transactions.bookingDate, from),
    lte(transactions.bookingDate, to),
  );
  const rows = getDB()
    .select({
      bookingDate: transactions.bookingDate,
      counterpartyName: transactions.counterpartyName,
      description: transactions.description,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(where)
    .orderBy(asc(transactions.bookingDate), asc(sql`"transactions"."rowid"`))
    .limit(MAX_STATEMENT_TRANSACTIONS + 1)
    .all();
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
    openingBalance: accountBalanceAt(userId, accountId, addDays(from, -1)),
    closingBalance: accountBalanceAt(userId, accountId, to),
    transactions: rows,
    generatedOn: today,
  };
}

export function loadBillsReport(
  userId: string,
  today: string = localToday(),
): BillsReportInput {
  return { bills: billViews(userId, { today }), asOf: today };
}

export function loadNetWorthReport(
  userId: string,
  today: string = localToday(),
  basis: ShareBasis = "total",
): NetWorthReportInput {
  return {
    series: netWorthSeries(userId, { today, basis }),
    balances: accountBalances(userId, today).map(({ iban, ...balance }) => ({
      ...balance,
      ibanMasked: iban ? maskIban(iban) : null,
    })),
    asOf: today,
    basis,
  };
}

export function loadTaxReport(
  userId: string,
  year: number,
  today: string = localToday(),
): TaxReportInput {
  const reconciliation = reconcileYear(userId, year);
  if (!reconciliation) throw notFound("Tax year");
  return { reconciliation, asOf: today };
}

export function loadTaxDeductionsReport(
  userId: string,
  year: number,
  today: string = localToday(),
): TaxDeductionsReportInput {
  return { summary: deductionSummary(userId, year), asOf: today };
}
