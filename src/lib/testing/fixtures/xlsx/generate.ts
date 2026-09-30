/**
 * Regenerates the synthetic .xlsx fixtures. Run with:
 *   bun src/lib/testing/fixtures/xlsx/generate.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildXlsx, type XlsxSheet } from "./build";

export const statementSheets: XlsxSheet[] = [
  {
    name: "Statement",
    rows: [
      [
        "Date",
        "Counterparty",
        "Description",
        "Reference",
        "Amount",
        "Currency",
      ],
      [
        { date: "2024-03-01" },
        "Example Employer AG",
        "Salary March",
        null,
        5200,
        "CHF",
      ],
      [
        { date: "2024-03-02" },
        "Sample Cafe",
        { rich: ["Coffee ", "and cake"] },
        null,
        { raw: "-4.5" },
        "CHF",
      ],
      [
        { date: "2024-03-03" },
        "Demo Utilities GmbH",
        { inline: "Invoice 2024-117" },
        "210000000003139471430009017",
        { raw: "-123.45" },
        "CHF",
      ],
      [
        { date: "2024-03-04" },
        "Sample Shop",
        "Float artefact",
        null,
        { raw: "0.3" },
        "CHF",
      ],
      [
        { date: "2024-03-05" },
        "Example Bank",
        "Tiny exponent",
        null,
        { raw: "1.5E-1" },
        "CHF",
      ],
      [{ date: "2024-03-06" }, "Sample Shop", "Zero", null, 0, "CHF"],
    ],
  },
  { name: "Ignored", rows: [["Not", "the", "first", "sheet"]] },
];

const dir = dirname(fileURLToPath(import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(dir, "statement.xlsx"), buildXlsx(statementSheets));
}
