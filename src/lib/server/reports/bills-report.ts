import type { Content, TableCell } from "pdfmake/interfaces";
import { minor, type Minor } from "$lib/money";
import { groupBills, type BillWithStatus } from "$lib/server/bills/status";
import {
  headerCell,
  heading,
  money,
  renderPdf,
  sectionTitle,
  table,
} from "./pdf";

export interface BillsReportInput {
  /** Every bill of the user with its status (see `billViews`). */
  bills: readonly BillWithStatus[];
  /** YYYY-MM-DD; also the PDF creation date. */
  asOf: string;
}

export const billsReportTitle = (input: BillsReportInput) =>
  `Bills ${input.asOf}`;

function label(b: BillWithStatus): Content {
  const lines: Content[] = [
    { text: b.creditorName ?? "Unknown creditor", bold: true },
  ];
  if (b.invoiceNumber) {
    lines.push({ text: `No. ${b.invoiceNumber}`, color: "#52525b" });
  }
  if (b.kind === "credit_note") {
    lines.push({ text: "Credit note", color: "#52525b" });
  }
  return { stack: lines };
}

function dueText(b: BillWithStatus): string {
  if (b.dueDate === null) return "-";
  return b.dueDate;
}

function section(
  title: string,
  bills: readonly BillWithStatus[],
  amountOf: (b: BillWithStatus) => Minor | null,
  amountHeader: string,
): Content[] {
  if (bills.length === 0) return [];
  const rows: TableCell[][] = bills.map((b) => {
    const total =
      b.amount === null ? "open amount" : money(b.amount, b.currency);
    const open = amountOf(b);
    return [
      label(b),
      { text: dueText(b), noWrap: true },
      { text: total, alignment: "right", noWrap: true },
      {
        text: open === null ? "-" : money(open, b.currency),
        alignment: "right",
        noWrap: true,
        bold: true,
      },
    ];
  });
  return [
    sectionTitle(`${title} (${bills.length})`),
    table(
      ["*", 62, "auto", "auto"],
      [
        [
          headerCell("Bill"),
          headerCell("Due"),
          headerCell("Amount", "right"),
          headerCell(amountHeader, "right"),
        ],
        ...rows,
      ],
    ),
  ];
}

const toPay = (b: BillWithStatus) => b.remaining;
function toGetBack(b: BillWithStatus): Minor | null {
  if (b.amount === null) return null;
  return b.status === "overpaid"
    ? minor(Math.max(0, b.settled - b.amount))
    : b.remaining;
}

function sumBy(
  bills: readonly BillWithStatus[],
  amountOf: (b: BillWithStatus) => Minor | null,
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const b of bills) {
    sums.set(b.currency, (sums.get(b.currency) ?? 0) + (amountOf(b) ?? 0));
  }
  return sums;
}

export async function billsReport(
  input: BillsReportInput,
): Promise<Uint8Array> {
  const groups = groupBills(input.bills, { today: input.asOf });
  const unpaid = [...groups.overdue, ...groups.dueSoon, ...groups.openOther];
  const payTotals = sumBy(unpaid, toPay);
  const refundTotals = sumBy(groups.awaitingRefund, toGetBack);
  const currencies = [
    ...new Set([...payTotals.keys(), ...refundTotals.keys()]),
  ].sort();

  const content: Content[] = [
    ...heading("Bills", `Status as of ${input.asOf}`),
    ...section("Overdue", groups.overdue, toPay, "Still to pay"),
    ...section("Due within 14 days", groups.dueSoon, toPay, "Still to pay"),
    ...section("Other open bills", groups.openOther, toPay, "Still to pay"),
    ...section(
      "Awaiting refund",
      groups.awaitingRefund,
      toGetBack,
      "To get back",
    ),
  ];
  if (unpaid.length + groups.awaitingRefund.length === 0) {
    content.push({
      text: "No open bills.",
      italics: true,
      margin: [0, 16, 0, 0],
    });
  } else {
    content.push(
      sectionTitle("Totals"),
      table(
        ["*", "auto", "auto"],
        [
          [
            headerCell("Currency"),
            headerCell("Still to pay", "right"),
            headerCell("To get back", "right"),
          ],
          ...currencies.map((c): TableCell[] => [
            { text: c },
            {
              text: money(minor(payTotals.get(c) ?? 0), c),
              alignment: "right",
              bold: true,
            },
            {
              text: money(minor(refundTotals.get(c) ?? 0), c),
              alignment: "right",
              bold: true,
            },
          ]),
        ],
      ),
    );
  }
  return renderPdf(
    { content },
    { title: billsReportTitle(input), generatedOn: input.asOf },
  );
}
