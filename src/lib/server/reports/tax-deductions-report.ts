import type { Content, TableCell } from "pdfmake/interfaces";
import { DEDUCTION_LABELS } from "$lib/tax-deductions";
import type { DeductionSummary } from "$lib/server/tax/deductions";
import {
  headerCell,
  heading,
  money,
  renderPdf,
  sectionTitle,
  table,
} from "./pdf";

export interface TaxDeductionsReportInput {
  summary: DeductionSummary;
  /** YYYY-MM-DD; also the PDF creation date. */
  asOf: string;
}

export const taxDeductionsReportTitle = (input: TaxDeductionsReportInput) =>
  `Tax ${input.summary.year} deductions`;

export async function taxDeductionsReport(
  input: TaxDeductionsReportInput,
): Promise<Uint8Array> {
  const { summary } = input;
  const content: Content[] = [
    ...heading(`Tax deductions ${summary.year}`, `Status as of ${input.asOf}`),
  ];

  if (summary.totals.length === 0) {
    content.push({
      text: "No deductible transactions for this year.",
      italics: true,
      margin: [0, 10, 0, 0],
    });
  } else {
    content.push(
      sectionTitle("Totals"),
      table(
        ["*", "auto", "auto"],
        [
          [
            headerCell("Deduction"),
            headerCell("Currency"),
            headerCell("Total", "right"),
          ],
          ...summary.totals.map((t): TableCell[] => [
            { text: DEDUCTION_LABELS[t.type] },
            { text: t.currency },
            {
              text: money(t.total, t.currency),
              alignment: "right",
              bold: true,
              noWrap: true,
            },
          ]),
        ],
      ),
    );
    for (const t of summary.totals) {
      content.push(
        sectionTitle(`${DEDUCTION_LABELS[t.type]} (${t.currency})`),
        table(
          ["auto", "*", "auto"],
          [
            [
              headerCell("Date"),
              headerCell("Counterparty"),
              headerCell("Amount", "right"),
            ],
            ...t.lines.map((l): TableCell[] => [
              { text: l.date, noWrap: true },
              { text: l.label ?? "-" },
              {
                text: money(l.amount, l.currency),
                alignment: "right",
                noWrap: true,
              },
            ]),
          ],
        ),
      );
    }
  }
  if (summary.excluded.length > 0) {
    content.push({
      text: `${summary.excluded.length} transaction(s) are excluded from these totals.`,
      italics: true,
      margin: [0, 10, 0, 0],
    });
  }
  return renderPdf(
    { content },
    { title: taxDeductionsReportTitle(input), generatedOn: input.asOf },
  );
}
