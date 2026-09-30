import { strToU8, zipSync, type Zippable } from "fflate";

/**
 * Minimal synthetic .xlsx writer used to generate fixtures and in-test
 * workbooks. Not a general-purpose writer.
 *
 *  - string: shared string
 *  - number: numeric cell
 *  - { raw }: numeric cell with the given literal `<v>` text (e.g. float artefacts)
 *  - { date }: ISO date stored as an Excel serial with a date format
 *  - { inline }: inline string, { rich }: shared rich-text string made of runs
 *  - { formulaText }: formula string result (t="str")
 *  - null: empty cell
 */
export type XlsxCell =
  | string
  | number
  | null
  | { raw: string }
  | { date: string }
  | { inline: string }
  | { rich: string[] }
  | { formulaText: string };

export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

export interface BuildXlsxOptions {
  date1904?: boolean;
  /** Overrides the cell reference of the first cell of each row (for sparse-sheet tests). */
  cellRefs?: (row: number, col: number) => string;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function excelSerial(iso: string, date1904 = false): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return Math.round((Date.UTC(y, m - 1, d) - epoch) / 86_400_000);
}

export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function buildXlsx(
  sheets: XlsxSheet[],
  options: BuildXlsxOptions = {},
): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const addShared = (xml: string) => {
    let idx = sharedIndex.get(xml);
    if (idx === undefined) {
      idx = shared.length;
      shared.push(xml);
      sharedIndex.set(xml, idx);
    }
    return idx;
  };
  const textNode = (s: string) => `<t xml:space="preserve">${xmlEscape(s)}</t>`;

  const sheetXml = (sheet: XlsxSheet) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            if (cell === null) return "";
            const ref = options.cellRefs
              ? options.cellRefs(r, c)
              : `${columnLetters(c)}${r + 1}`;
            if (typeof cell === "string") {
              return `<c r="${ref}" t="s"><v>${addShared(`<si>${textNode(cell)}</si>`)}</v></c>`;
            }
            if (typeof cell === "number")
              return `<c r="${ref}"><v>${cell}</v></c>`;
            if ("raw" in cell) return `<c r="${ref}"><v>${cell.raw}</v></c>`;
            if ("date" in cell) {
              return `<c r="${ref}" s="1"><v>${excelSerial(cell.date, options.date1904)}</v></c>`;
            }
            if ("inline" in cell) {
              return `<c r="${ref}" t="inlineStr"><is>${textNode(cell.inline)}</is></c>`;
            }
            if ("rich" in cell) {
              const runs = cell.rich
                .map((t) => `<r>${textNode(t)}</r>`)
                .join("");
              return `<c r="${ref}" t="s"><v>${addShared(`<si>${runs}</si>`)}</v></c>`;
            }
            return `<c r="${ref}" t="str"><f>A1</f><v>${xmlEscape(cell.formulaText)}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };

  const sheetFiles = sheets.map(sheetXml);
  const n = sheets.length;
  const mtime = new Date(2024, 0, 1, 12, 0, 0);
  const file = (xml: string): [Uint8Array, { mtime: Date; level: 6 }] => [
    strToU8(xml),
    { mtime, level: 6 },
  ];
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

  const files: Zippable = {
    "[Content_Types].xml": file(
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "_rels/.rels": file(
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": file(
      `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${options.date1904 ? `<workbookPr date1904="1"/>` : ""}<sheets>${sheets
        .map(
          (s, i) =>
            `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
        )
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": file(
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          "",
        )}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/styles.xml": file(
      `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    ),
    "xl/sharedStrings.xml": file(
      `${head}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.join("")}</sst>`,
    ),
  };
  sheetFiles.forEach((xml, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = file(xml);
  });
  return zipSync(files);
}
