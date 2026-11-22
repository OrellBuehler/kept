import { z } from "zod";
import {
  accountBalances,
  balanceTotals,
  netWorthSeries,
} from "$lib/server/dashboard";
import { addMonths } from "$lib/server/dashboard/dates";
import { listAccountDtos, listQuery } from "$lib/server/external-api/catalog";
import { accountAllowed } from "$lib/server/ledger/visibility";
import { LedgerError } from "$lib/server/ledger/errors";
import {
  dateString,
  decimal,
  decimalOrNull,
  MCP_DEFAULT_LIMIT,
  pagingInput,
} from "../format";
import { defineTool, holds } from "../tool";

const MAX_NET_WORTH_YEARS = 10;

export const accountTools = [
  defineTool({
    name: "list_accounts",
    title: "List accounts",
    description:
      "Lists the owner's accounts: id, name, currency, type (checking, savings, credit card, investment, pillar 3a...) and whether it is archived. No balances (see get_balances) and no IBANs. Account ids are used by list_transactions and in payments' accountId. A connection limited to some accounts only sees those.",
    scopes: ["accounts:read"],
    annotations: { readOnlyHint: true },
    input: { ...pagingInput },
    run: async (ctx, args) => {
      const page = await listAccountDtos(
        ctx.userId,
        ctx.grant,
        listQuery.parse({
          limit: String(args.limit ?? MCP_DEFAULT_LIMIT),
          cursor: args.cursor,
        }),
      );
      return {
        items: page.items.map((a) => ({
          id: a.id,
          name: a.name,
          currency: a.currency,
          type: a.type,
          archived: a.archived,
        })),
        nextCursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: "get_balances",
    title: "Get account balances",
    description:
      "Current balance of every non-archived account as of today (name and type only when the connection may also read accounts), in the account's currency (decimal strings): balance (cash plus holdings), cashBalance, the value of holdings when the account holds securities, the date of the latest booking and whether the data is stale (no recent import). totals sums the listed accounts per currency; currencies are never mixed. A connection limited to some accounts only gets those accounts and their totals.",
    scopes: ["balances:read"],
    annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => {
      const rows = (await accountBalances(ctx.userId, ctx.today)).filter((a) =>
        accountAllowed(ctx.grant, a.id),
      );
      const labelled = holds(ctx, "accounts:read");
      return {
        asOf: ctx.today,
        accounts: rows.map((a) => ({
          id: a.id,
          // An account's name and type belong to accounts:read.
          name: labelled ? a.name : null,
          type: labelled ? a.type : null,
          currency: a.currency,
          balance: decimal(a.balance, a.currency),
          cashBalance: decimal(a.cashBalance, a.currency),
          holdingsValue: decimalOrNull(a.holdings?.value ?? null, a.currency),
          lastBookingDate: a.lastBookingDate,
          stale: a.stale,
          noData: a.noData,
        })),
        totals: balanceTotals(rows).map((t) => ({
          currency: t.currency,
          balance: decimal(t.balance, t.currency),
          accountCount: t.accountCount,
        })),
      };
    },
  }),

  defineTool({
    name: "get_net_worth",
    title: "Get the net worth over time",
    description:
      "The sum of all non-archived accounts' balances at each date, per currency (decimal strings; currencies are never mixed), oldest first. Defaults to the last 12 months in monthly steps. Not available to a connection limited to some accounts, because it is a total over all of them.",
    scopes: ["balances:read"],
    unavailableWhen: ["accounts"],
    annotations: { readOnlyHint: true },
    input: {
      from: dateString
        .optional()
        .describe("First date (default 12 months ago)."),
      to: dateString.optional().describe("Last date (default today)."),
      step: z.enum(["week", "month"]).optional().describe("Default month."),
    },
    run: async (ctx, args) => {
      const to = args.to ?? ctx.today;
      const from = args.from ?? addMonths(to, -12);
      if (from > to) {
        throw new LedgerError("invalid", "from must not be after to.");
      }
      if (from < addMonths(to, -12 * MAX_NET_WORTH_YEARS)) {
        throw new LedgerError(
          "invalid",
          `The range may span at most ${MAX_NET_WORTH_YEARS} years.`,
        );
      }
      const series = await netWorthSeries(ctx.userId, {
        from,
        to,
        step: args.step ?? "month",
        today: ctx.today,
      });
      return {
        series: series.map((s) => ({
          currency: s.currency,
          points: s.points.map((p) => ({
            date: p.date,
            amount: decimal(p.amount, s.currency),
          })),
        })),
      };
    },
  }),
];
