import type { Content, TableCell } from "pdfmake/interfaces";
import { formatShare, minor, type ShareBasis } from "$lib/money";
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
  "name" | "type" | "currency" | "balance" | "shareBps" | "shareBalance"
> & { ibanMasked: string | null; institution: { name: string } | null };

export interface NetWorthReportInput {
  /** History per currency; all series share the same dates. */
  series: readonly NetWorthCurrencySeries[];
  balances: readonly NetWorthBalance[];
  /** YYYY-MM-DD; also the PDF creation date. */
  asOf: string;
  /**
   * "share" prints every account at its ownership share (the series must have
   * been built with the same basis). Default "total".
   */
  basis?: ShareBasis;
}

export const netWorthReportTitle = (input: NetWorthReportInput) =>
  input.basis === "share"
    ? `Net worth, my share ${input.asOf}`
    : `Net worth ${input.asOf}`;

const typeLabel = (type: string) => type.replaceAll("_", " ");

export async function netWorthReport(
  input: NetWorthReportInput,
): Promise<Uint8Array> {
  const share = input.basis === "share";
  const valueOf = (b: NetWorthBalance) => (share ? b.shareBalance : b.balance);
  const currencies = [...new Set(input.balances.map((b) => b.currency))].sort();
  const content: Content[] = [
    ...heading(
      share ? "Net worth, my share" : "Net worth",
      share
        ? `Balances as of ${input.asOf}, each account counted at your ownership share`
        : `Balances as of ${input.asOf}`,
    ),
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
    const total = accounts.reduce((sum, a) => sum + valueOf(a), 0);
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
      ...(share
        ? [{ text: formatShare(a.shareBps), alignment: "right" as const }]
        : []),
      { text: money(valueOf(a), currency), alignment: "right", noWrap: true },
    ]);
    rows.push([
      { text: "Total", bold: true },
      { text: "" },
      ...(share ? [{ text: "" }] : []),
      {
        text: money(minor(total), currency),
        alignment: "right",
        bold: true,
        noWrap: true,
      },
    ]);
    content.push(
      sectionTitle(`Accounts in ${currency}`),
      table(share ? ["*", 80, 50, "auto"] : ["*", 80, "auto"], [
        [
          headerCell("Account"),
          headerCell("Type"),
          ...(share ? [headerCell("Share", "right")] : []),
          headerCell(share ? "Balance (share)" : "Balance", "right"),
        ],
        ...rows,
      ]),
    );
  }

  const dates = input.series[0]?.points.map((p) => p.date) ?? [];
  if (dates.length > 0) {
    content.push(
      sectionTitle(share ? "History (my share)" : "History"),
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
