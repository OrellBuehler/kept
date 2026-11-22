import { z } from "zod";
import { formatFixed } from "$lib/quantity";
import { SERIES_STATUSES } from "$lib/recurring-types";
import { budgetReport, monthSchema } from "$lib/server/categories";
import {
  listRecurringDtos,
  recurringQuery,
} from "$lib/server/external-api/catalog";
import { forecast, listPlannedItems } from "$lib/server/forecast";
import { HORIZONS } from "$lib/server/forecast/schemas";
import { investmentsOverview } from "$lib/server/investments";
import { pillar3aOverview } from "$lib/server/pillar3a";
import { listTaxYears, reconcileYear } from "$lib/server/tax";
import type { TaxBalance } from "$lib/server/tax/matching";
import { LedgerError } from "$lib/server/ledger/errors";
import {
  decimal,
  decimalOrNull,
  MCP_DEFAULT_LIMIT,
  pagingInput,
} from "../format";
import { defineTool, holds } from "../tool";

const MAX_FORECAST_ITEMS = 200;

function balanceOut(b: TaxBalance, currency: string) {
  return {
    paidByMe: decimal(b.paidByMe, currency),
    creditedByOffice: decimal(b.creditedByOffice, currency),
    difference: decimal(b.difference, currency),
    assessedTotal: decimalOrNull(b.assessedTotal, currency),
    remaining: decimalOrNull(b.remaining, currency),
    outcome: b.outcome,
    amountDue: decimal(b.amountDue, currency),
    refundExpected: decimal(b.refundExpected, currency),
  };
}

export const overviewTools = [
  defineTool({
    name: "get_budgets",
    title: "Get budgets and spending for a month",
    description:
      "Budget against spending per category for one month, per currency (currencies are never mixed). Each row has the category, the budget, what was spent (including its subcategories) and what remains (negative when over budget), all decimal strings. The category name is given only when the connection may also read categories (the id always is). unbudgeted lists categories with spending but no budget. Only for connections without a restriction to accounts or categories, because spending is summed over everything.",
    scopes: ["budgets:read"],
    annotations: { readOnlyHint: true },
    input: {
      month: monthSchema
        .optional()
        .describe("YYYY-MM, default the current month."),
    },
    run: async (ctx, { month }) => {
      const report = await budgetReport(
        ctx.userId,
        month ?? ctx.today.slice(0, 7),
      );
      // Category names belong to categories:read; the ids stay.
      const named = holds(ctx, "categories:read");
      const label = (parent: string | null, name: string) =>
        named ? (parent ? `${parent} / ${name}` : name) : null;
      return {
        month: report.month,
        currencies: report.currencies.map((c) => ({
          currency: c.currency,
          totalBudget: decimal(c.totalBudget, c.currency),
          totalSpent: decimal(c.totalSpent, c.currency),
          budgets: c.rows.map((r) => ({
            categoryId: r.categoryId,
            category: label(r.parentName, r.categoryName),
            budget: decimal(r.budget, c.currency),
            spent: decimal(r.spent, c.currency),
            remaining: decimal(r.remaining, c.currency),
            over: r.over,
          })),
          unbudgeted: c.unbudgeted.map((u) => ({
            categoryId: u.categoryId,
            category: label(u.parentName, u.categoryName),
            spent: decimal(u.spent, c.currency),
          })),
        })),
      };
    },
  }),

  defineTool({
    name: "list_recurring_payments",
    title: "List recurring payments",
    description:
      "Lists recurring payments Kept detected (subscriptions, rent, insurance...): name, cadence, typical amount per occurrence, monthly and annual cost (negative: money out, decimal strings in the currency), when the next one is expected and whether it is overdue. status is suggested (detected, not yet confirmed by the owner), confirmed or dismissed. Not available to a connection limited to some accounts or categories, because they are detected across all of them.",
    scopes: ["recurring:read"],
    annotations: { readOnlyHint: true },
    input: {
      status: z.enum(SERIES_STATUSES).optional(),
      ...pagingInput,
    },
    run: async (ctx, args) => {
      const page = await listRecurringDtos(
        ctx.userId,
        ctx.grant,
        recurringQuery.parse({
          limit: String(args.limit ?? MCP_DEFAULT_LIMIT),
          cursor: args.cursor,
          status: args.status,
        }),
      );
      return {
        items: page.items.map((s) => ({
          id: s.id,
          status: s.status,
          name: s.name,
          cadence: s.cadence,
          currency: s.currency,
          amount: decimal(s.amount, s.currency),
          monthlyCost: decimal(s.monthlyCost, s.currency),
          annualCost: decimal(s.annualCost, s.currency),
          firstDate: s.firstDate,
          lastDate: s.lastDate,
          lastAmount: decimal(s.lastAmount, s.currency),
          occurrences: s.occurrences,
          nextExpected: s.nextExpected,
          overdue: s.overdue,
        })),
        nextCursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: "get_forecast",
    title: "Get the cash-flow forecast",
    description: `Projects each account's balance over the next 30, 60 or 90 days from open bills and the owner's planned items: start and end balance, the lowest point, a low-balance warning date and the date it goes negative, as decimal strings in the account's currency. items lists the expected movements in the horizon (negative: money out), at most ${MAX_FORECAST_ITEMS}. unprojectedBills counts unpaid bills that could not be projected (no due date or amount). Not available to a connection limited to some accounts or categories.`,
    scopes: ["forecast:read"],
    annotations: { readOnlyHint: true },
    input: {
      days: z
        .union(
          HORIZONS.map((h) => z.literal(h)) as [
            z.ZodLiteral<30>,
            z.ZodLiteral<60>,
            z.ZodLiteral<90>,
          ],
        )
        .optional()
        .describe("Horizon in days: 30 (default), 60 or 90."),
    },
    run: async (ctx, { days }) => {
      const f = await forecast(ctx.userId, ctx.today, days ?? 30);
      const items = f.items.slice(0, MAX_FORECAST_ITEMS);
      // Account names belong to accounts:read, the creditor of a bill to bills:read.
      const named = holds(ctx, "accounts:read");
      const bills = holds(ctx, "bills:read");
      return {
        from: f.from,
        to: f.to,
        accounts: f.accounts.map((a) => ({
          accountId: a.accountId,
          name: named ? a.name : null,
          currency: a.currency,
          hasBalance: a.hasBalance,
          startBalance: decimal(a.startBalance, a.currency),
          endBalance: decimal(a.endBalance, a.currency),
          lowest: {
            date: a.lowest.date,
            balance: decimal(a.lowest.balance, a.currency),
          },
          warningDate: a.warning?.date ?? null,
          negativeDate: a.negativeDate,
        })),
        items: items.map((i) => ({
          date: i.date,
          amount: decimal(i.amount, i.currency),
          currency: i.currency,
          accountId: i.accountId,
          source: i.source,
          label: i.source === "bill" && !bills ? null : i.label,
        })),
        itemsTruncated: f.items.length > items.length,
        unassigned: f.unassigned.map((u) => ({
          currency: u.currency,
          inflow: decimal(u.inflow, u.currency),
          outflow: decimal(u.outflow, u.currency),
          count: u.count,
        })),
        unprojectedBills: f.unprojectedBills,
      };
    },
  }),

  defineTool({
    name: "list_planned_items",
    title: "List planned income and expenses",
    description:
      "Lists the one-off income and expenses the owner entered for the forecast: date, signed decimal amount (negative: expense) with currency, label and the account id when one is set, oldest first. Not available to a connection limited to some accounts or categories.",
    scopes: ["forecast:read"],
    annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => ({
      items: (await listPlannedItems(ctx.userId)).map((p) => ({
        id: p.id,
        date: p.date,
        amount: decimal(p.amount, p.currency),
        currency: p.currency,
        label: p.label,
        accountId: p.accountId,
      })),
    }),
  }),

  defineTool({
    name: "get_investments",
    title: "Get investment holdings",
    description:
      "Current holdings of the non-archived investment accounts, grouped by security: quantity, latest price and its date, and per account the position's value, cost and gain in the account's currency (decimal strings). totals sums value, cost and gain per currency; estimated means a position had to be valued at cost because an exchange rate is missing. A connection limited to some accounts only counts those accounts.",
    scopes: ["investments:read"],
    annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => {
      const o = await investmentsOverview(ctx.userId, ctx.today, ctx.grant);
      const named = holds(ctx, "accounts:read");
      return {
        asOf: ctx.today,
        totals: o.totals.map((t) => ({
          currency: t.currency,
          value: decimal(t.value, t.currency),
          cost: decimal(t.cost, t.currency),
          gain: decimal(t.gain, t.currency),
          estimated: t.estimated,
        })),
        securities: o.securities.map((g) => ({
          securityId: g.securityId,
          name: g.name,
          priceCurrency: g.currency,
          quantity: formatFixed(g.quantity),
          price: formatFixed(g.price),
          priceDate: g.priceDate,
          positions: g.positions.map((p) => ({
            accountId: p.accountId,
            accountName: named ? p.accountName : null,
            accountCurrency: p.accountCurrency,
            quantity: formatFixed(p.quantity),
            value: decimal(p.value, p.accountCurrency),
            cost: decimal(p.cost, p.accountCurrency),
            gain: decimal(p.gain, p.accountCurrency),
            estimated: p.estimated,
          })),
        })),
      };
    },
  }),

  defineTool({
    name: "get_pillar3a",
    title: "Get pillar 3a overview",
    description:
      "Pillar 3a (Swiss retirement savings) overview in CHF as decimal strings: per year the contribution limit, ordinary contributions, buy-ins, the gap still open and any amount over the limit; the portfolios with latest value, contributed amount and gain (value minus contributions), plus, when entered with that value, the total gain the provider reported and the total return in percent (the figure of the provider, or else that gain over the capital it grew from); and totals. Not available to a connection limited to some accounts or categories, because limits count across all accounts.",
    scopes: ["pillar3a:read"],
    annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => {
      const o = await pillar3aOverview(ctx.userId, ctx.today);
      const named = holds(ctx, "accounts:read");
      const chf = (v: number) => decimal(v, "CHF");
      // Hundredths of a percent have the two decimals of CHF.
      const percent = (bps: number) => decimal(bps, "CHF");
      return {
        asOf: o.today,
        currency: "CHF",
        years: o.years.map((y) => ({
          year: y.year,
          deduction: y.deduction,
          limit: chf(y.limit),
          limitUnconfirmed: y.limitUnconfirmed,
          ordinary: chf(y.ordinary),
          buyIn: chf(y.buyIn),
          gap: chf(y.gap),
          overLimit: chf(y.overLimit),
          buyInEligible: y.buyInEligible,
        })),
        portfolios: o.portfolios.map((p) => ({
          portfolioId: p.portfolioId,
          accountId: p.accountId,
          accountName: named ? p.accountName : null,
          name: p.name,
          archived: p.archived,
          closedOn: p.closedOn,
          latestValue: p.latestValue === null ? null : chf(p.latestValue),
          latestValueDate: p.latestValueDate,
          contributed: chf(p.contributed),
          gain: p.gain === null ? null : chf(p.gain),
          reportedGain: p.reportedGain === null ? null : chf(p.reportedGain),
          returnPercent: p.returnBps === null ? null : percent(p.returnBps),
        })),
        totals: {
          value: chf(o.totals.value),
          contributed: chf(o.totals.contributed),
          gain: chf(o.totals.gain),
          accountsValue: chf(o.totals.accountsValue),
        },
        ageBenefitDrawn: o.ageBenefitDrawn,
      };
    },
  }),

  defineTool({
    name: "list_tax_years",
    title: "List tax years",
    description:
      "Lists the tax years the owner tracks, newest first: tax authority, currency, the balance between what the owner paid and what the tax office counted (decimal strings), the outcome (due, refund, settled, unknown) and how many lines do not reconcile. Use the year with get_tax_year. Not available to a connection limited to some accounts or categories.",
    scopes: ["taxes:read"],
    annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => ({
      items: (await listTaxYears(ctx.userId)).map((y) => ({
        year: y.year,
        authority: y.authority,
        currency: y.currency,
        balance: balanceOut(y.balance, y.currency),
        discrepancies: y.discrepancies,
        reconciled: y.reconciled,
      })),
    }),
  }),

  defineTool({
    name: "get_tax_year",
    title: "Get a tax year's reconciliation",
    description:
      "Reconciles one tax year: the owner's tax payments against the lines the tax office counted. Each row is matched, amount_mismatch, missing_office (paid but not counted) or missing_mine (counted but no payment found), with dates, decimal amounts and the payment id; plus the balance and counts. Not available to a connection limited to some accounts or categories.",
    scopes: ["taxes:read"],
    annotations: { readOnlyHint: true },
    input: { year: z.number().int().min(1900).max(2200) },
    run: async (ctx, { year }) => {
      const r = await reconcileYear(ctx.userId, year);
      if (!r) throw new LedgerError("not_found", "Tax year not found.");
      const cur = r.year.currency;
      // The payment's counterparty belongs to transactions:read.
      const payments = holds(ctx, "transactions:read");
      return {
        year: r.year.year,
        authority: r.year.authority,
        currency: cur,
        assessedTotal: decimalOrNull(r.year.assessedTotal, cur),
        balance: balanceOut(r.balance, cur),
        counts: r.counts,
        reconciled: r.reconciled,
        rows: r.rows.map((row) => ({
          kind: row.kind,
          date: row.date,
          difference: decimal(row.difference, cur),
          payment: row.mine
            ? {
                paymentId: row.mine.transactionId,
                amount: decimal(row.mine.amount, cur),
                counterparty: payments ? row.mine.label : null,
                via: row.mine.via,
              }
            : null,
          taxOffice: row.office
            ? {
                amount: decimal(row.office.amount, cur),
                description: row.office.description,
              }
            : null,
        })),
      };
    },
  }),
];
