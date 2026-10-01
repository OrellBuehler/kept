import type { Content, TableCell } from "pdfmake/interfaces";
import type { Minor } from "$lib/money";
import type { Reconciliation, RowKind } from "$lib/server/tax/tax";
import {
  headerCell,
  heading,
  money,
  renderPdf,
  sectionTitle,
  table,
} from "./pdf";

export interface TaxReportInput {
  reconciliation: Reconciliation;
  /** YYYY-MM-DD; also the PDF creation date. */
  asOf: string;
}

export const taxReportTitle = (input: TaxReportInput) =>
  `Tax ${input.reconciliation.year.year} reconciliation`;

const STATUS: Record<RowKind, { text: string; color: string }> = {
  matched: { text: "Matched", color: "#15803d" },
  amount_mismatch: { text: "Amount differs", color: "#b91c1c" },
  missing_office: { text: "Not counted by tax office", color: "#b91c1c" },
  missing_mine: { text: "Not in your payments", color: "#b91c1c" },
};

function outcomeText(r: Reconciliation): string {
  const { balance } = r;
  const c = r.year.currency;
  if (balance.outcome === "unknown") return "No assessment entered yet.";
  if (balance.outcome === "settled") return "Settled: nothing is open.";
  if (balance.outcome === "due") {
    return `Still due: ${money(balance.amountDue, c)}`;
  }
  return `Refund to expect: ${money(balance.refundExpected, c)}`;
}

function summary(r: Reconciliation): Content {
  const c = r.year.currency;
  const { balance } = r;
  const row = (label: string, value: string, bold = false): TableCell[] => [
    { text: label },
    { text: value, alignment: "right", bold },
  ];
  return table(
    ["*", "auto"],
    [
      [headerCell("Summary"), headerCell("", "right")],
      row("Paid by you", money(balance.paidByMe, c)),
      row("Counted by the tax office", money(balance.creditedByOffice, c)),
      row("Difference", money(balance.difference, c), balance.difference !== 0),
      row(
        "Assessed total",
        balance.assessedTotal === null ? "-" : money(balance.assessedTotal, c),
      ),
      row(
        "Remaining by the tax office's figures",
        balance.remaining === null ? "-" : money(balance.remaining, c),
        true,
      ),
      row(
        "Remaining by your payments",
        balance.remainingByMe === null ? "-" : money(balance.remainingByMe, c),
      ),
    ],
  );
}

function side(
  line: { date: string; amount: Minor; reference: string | null } | null,
  currency: string,
): TableCell[] {
  if (!line) {
    return [
      { text: "-", color: "#52525b" },
      { text: "-", alignment: "right" },
    ];
  }
  return [
    {
      stack: [
        { text: line.date, noWrap: true },
        ...(line.reference
          ? [{ text: line.reference, color: "#52525b", fontSize: 8 }]
          : []),
      ],
    },
    {
      text: money(line.amount, currency),
      alignment: "right",
      noWrap: true,
    },
  ];
}

export async function taxReport(input: TaxReportInput): Promise<Uint8Array> {
  const r = input.reconciliation;
  const c = r.year.currency;
  const subtitle = [r.year.authority, `Status as of ${input.asOf}`]
    .filter(Boolean)
    .join(" - ");

  const content: Content[] = [
    ...heading(`Tax ${r.year.year}`, subtitle),
    { text: outcomeText(r), bold: true, margin: [0, 10, 0, 10] },
    summary(r),
    sectionTitle("Reconciliation"),
  ];

  if (r.rows.length === 0) {
    content.push({
      text: "No payments or statement lines yet.",
      italics: true,
    });
  } else {
    content.push(
      table(
        ["auto", "auto", "auto", "auto", "*"],
        [
          [
            headerCell("Your payment"),
            headerCell("Amount", "right"),
            headerCell("Tax office"),
            headerCell("Amount", "right"),
            headerCell("Status"),
          ],
          ...r.rows.map((row): TableCell[] => [
            ...side(row.mine, c),
            ...side(row.office, c),
            {
              text:
                STATUS[row.kind].text +
                (row.kind === "matched"
                  ? ""
                  : ` (${money(row.difference, c)})`),
              color: STATUS[row.kind].color,
              bold: row.kind !== "matched",
            },
          ]),
        ],
      ),
    );
  }
  if (r.otherCurrencyLines > 0) {
    content.push({
      text: `${r.otherCurrencyLines} tagged payment(s) in another currency than ${c} are not counted.`,
      italics: true,
      margin: [0, 10, 0, 0],
    });
  }
  return renderPdf(
    { content },
    { title: taxReportTitle(input), generatedOn: input.asOf },
  );
}
