import type { Content, TableCell } from "pdfmake/interfaces";
import type { Minor } from "$lib/money";
import {
  headerCell,
  heading,
  money,
  renderPdf,
  sectionTitle,
  table,
} from "./pdf";

export interface StatementTransaction {
  bookingDate: string;
  counterpartyName: string | null;
  description: string | null;
  amount: Minor;
}

export interface AccountStatementInput {
  account: {
    name: string;
    institutionName: string | null;
    /** Already masked. */
    ibanMasked: string | null;
    currency: string;
  };
  from: string;
  to: string;
  openingBalance: Minor;
  closingBalance: Minor;
  /** Oldest first. */
  transactions: readonly StatementTransaction[];
  /** YYYY-MM-DD; also the PDF creation date. */
  generatedOn: string;
}

function summaryRow(label: string, value: string): TableCell[] {
  return [
    { text: label, color: "#52525b" },
    { text: value, alignment: "right", bold: true },
  ];
}

export function accountStatementTitle(input: AccountStatementInput): string {
  return `Account statement ${input.account.name} ${input.from} to ${input.to}`;
}

export async function accountStatementReport(
  input: AccountStatementInput,
): Promise<Uint8Array> {
  const { account, transactions } = input;
  const cur = account.currency;
  let incoming = 0;
  let outgoing = 0;
  for (const t of transactions) {
    if (t.amount > 0) incoming += t.amount;
    else outgoing -= t.amount;
  }
  const adjustment =
    input.closingBalance - input.openingBalance - (incoming - outgoing);
  const details = [
    account.institutionName,
    account.ibanMasked,
    `Currency ${cur}`,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const rows: TableCell[][] = transactions.map((t) => {
    const lines: Content[] = [];
    if (t.counterpartyName)
      lines.push({ text: t.counterpartyName, bold: true });
    if (t.description) lines.push({ text: t.description, color: "#52525b" });
    return [
      { text: t.bookingDate, noWrap: true },
      lines.length ? { stack: lines } : { text: "" },
      {
        text: money(t.amount, cur),
        alignment: "right",
        noWrap: true,
        color: t.amount < 0 ? "#b91c1c" : undefined,
      },
    ];
  });

  const content: Content[] = [
    ...heading(account.name, details),
    {
      text: `Statement from ${input.from} to ${input.to}`,
      margin: [0, 10, 0, 0],
    },
    {
      margin: [0, 10, 0, 0],
      table: {
        widths: ["*", "auto"],
        body: [
          summaryRow("Opening balance", money(input.openingBalance, cur)),
          summaryRow("Total in", money(incoming as Minor, cur)),
          summaryRow("Total out", money(outgoing as Minor, cur)),
          summaryRow("Closing balance", money(input.closingBalance, cur)),
          summaryRow("Transactions", String(transactions.length)),
        ],
      },
      layout: "noBorders",
    },
    ...(adjustment !== 0
      ? [
          {
            text: `Adjusted by balance snapshot: ${money(adjustment as Minor, cur)}`,
            italics: true,
            fontSize: 9,
            margin: [0, 6, 0, 0],
          } as Content,
        ]
      : []),
    sectionTitle("Transactions"),
    transactions.length
      ? table(
          [62, "*", "auto"],
          [
            [
              headerCell("Date"),
              headerCell("Counterparty / description"),
              headerCell("Amount", "right"),
            ],
            ...rows,
          ],
        )
      : { text: "No transactions in this period.", italics: true },
  ];

  return renderPdf(
    { content },
    { title: accountStatementTitle(input), generatedOn: input.generatedOn },
  );
}
