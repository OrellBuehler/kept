import type { Content, TableCell } from "pdfmake/interfaces";
import { minor } from "$lib/money";
import type { AccountBalanceView } from "$lib/server/dashboard/accounts";
import type { NetWorthCurrencySeries } from "$lib/server/dashboard/net-worth";
import {
  headerCell,
  heading,
  money,
  renderPdf,
  sectionTitle,
  table,
} from "./pdf";

export type NetWorthBalance = Pick<
  AccountBalanceView,
  "name" | "type" | "currency" | "balance"
> & { ibanMasked: string | null; institution: { name: string } | null };

export interface NetWorthReportInput {
  /** History per currency; all series share the same dates. */
  series: readonly NetWorthCurrencySeries[];
  balances: readonly NetWorthBalance[];
  /** YYYY-MM-DD; also the PDF creation date. */
  asOf: string;
}

export const netWorthReportTitle = (input: NetWorthReportInput) =>
  `Net worth ${input.asOf}`;

const typeLabel = (type: string) => type.replaceAll("_", " ");

export async function netWorthReport(
  input: NetWorthReportInput,
): Promise<Uint8Array> {
  const currencies = [...new Set(input.balances.map((b) => b.currency))].sort();
  const content: Content[] = [
    ...heading("Net worth", `Balances as of ${input.asOf}`),
  ];

  if (currencies.length === 0) {
    content.push({
      text: "No accounts.",
      italics: true,
      margin: [0, 16, 0, 0],
    });
  }

  for (const currency of currencies) {
    const accounts = input.balances.filter((b) => b.currency === currency);
    const total = accounts.reduce((sum, a) => sum + a.balance, 0);
    const rows: TableCell[][] = accounts.map((a) => [
      {
        stack: [
          { text: a.name, bold: true },
          {
            text: [a.institution?.name, a.ibanMasked]
              .filter(Boolean)
              .join("  ·  "),
            color: "#52525b",
          },
        ],
      },
      { text: typeLabel(a.type) },
      { text: money(a.balance, currency), alignment: "right", noWrap: true },
    ]);
    rows.push([
      { text: "Total", bold: true },
      { text: "" },
      {
        text: money(minor(total), currency),
        alignment: "right",
        bold: true,
        noWrap: true,
      },
    ]);
    content.push(
      sectionTitle(`Accounts in ${currency}`),
      table(
        ["*", 80, "auto"],
        [
          [
            headerCell("Account"),
            headerCell("Type"),
            headerCell("Balance", "right"),
          ],
          ...rows,
        ],
      ),
    );
  }

  const dates = input.series[0]?.points.map((p) => p.date) ?? [];
  if (dates.length > 0) {
    content.push(
      sectionTitle("History"),
      table(
        ["*", ...input.series.map(() => "auto" as const)],
        [
          [
            headerCell("Date"),
            ...input.series.map((s) => headerCell(s.currency, "right")),
          ],
          ...dates.map((date, i): TableCell[] => [
            { text: date },
            ...input.series.map((s): TableCell => ({
              text: money(s.points[i]!.amount, s.currency),
              alignment: "right",
              noWrap: true,
            })),
          ]),
        ],
      ),
    );
  }

  return renderPdf(
    { content },
    { title: netWorthReportTitle(input), generatedOn: input.asOf },
  );
}
