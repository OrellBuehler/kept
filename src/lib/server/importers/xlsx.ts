import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { ImportFormatError } from "./types";

export const XLSX_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxXmlBytes: 25 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioCheckFromBytes: 100_000,
  maxExponent: 40,
  maxRows: 200_000,
  maxColumns: 512,
} as const;

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) =>
    ["row", "c", "si", "r", "sheet", "Relationship", "xf", "numFmt"].includes(
      name,
    ),
});

function asNode(v: unknown): Node {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

/** Text of a `<t>` element, which may carry attributes (xml:space) and thus be an object. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  const text = asNode(v)["#text"];
  return typeof text === "string" ? text : "";
}

/** Rich-text strings are a sequence of runs `<r><t>`; phonetic hints (`rPh`) are ignored. */
function stringItemText(si: unknown): string {
  const node = asNode(si);
  if (node["r"] !== undefined) {
    return asArray(node["r"])
      .map((r) => textOf(asNode(r)["t"]))
      .join("");
  }
  return textOf(node["t"]);
}

function unescapeXlsxText(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function parseXml(input: Uint8Array | string, what: string): Node {
  try {
    return asNode(
      parser.parse(typeof input === "string" ? input : strFromU8(input)),
    );
  } catch (cause) {
    throw new ImportFormatError(`XLSX ${what} is not well-formed XML`, {
      cause,
    });
  }
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "");
  if (/^general$/i.test(stripped.trim())) return false;
  return /[dmyhs]/i.test(stripped);
}

function plainDecimal(s: string): string {
  const m = /^([+-]?)(\d*)\.?(\d*)[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int = "", frac = "", exp = "0"] = m;
  const digits = int + frac;
  const point = int.length + Number(exp);
  let out: string;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length)
    out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  out = out.replace(/^0+(?=\d)/, "");
  if (out.includes(".")) out = out.replace(/\.?0+$/, "");
  return (sign === "-" && /[1-9]/.test(out) ? "-" : "") + out;
}

/**
 * Renders a stored number as a plain decimal string without changing its
 * value: plain decimals are returned as stored, exponent notation is expanded
 * exactly. Nothing is rounded, so a float artefact such as 0.30000000000000004
 * stays visible and is rejected by the amount parser (too many decimals)
 * instead of being silently altered.
 */
export function numberToPlainString(raw: string): string {
  const s = raw.trim();
  const m = /^[+-]?\d*\.?\d*[eE]([+-]?\d+)$/.exec(s);
  if (m && Math.abs(Number(m[1])) > XLSX_LIMITS.maxExponent) {
    throw new ImportFormatError("XLSX contains a number with a huge exponent");
  }
  return plainDecimal(s).replace(/^\+/, "");
}

function serialToIsoDate(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) {
    throw new ImportFormatError("XLSX contains an out-of-range date value");
  }
  const whole = Math.floor(serial);
  // Excel's 1900 system treats 1900 as a leap year; serials >= 61 map from 1899-12-30.
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : whole < 60
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + whole * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function columnIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0];
  if (!letters) throw new ImportFormatError(`Invalid cell reference "${ref}"`);
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export interface ReadXlsxOptions {
  /** Decimal separator used when rendering numeric cells; match the mapping profile. */
  decimalSeparator?: "." | ",";
}

/**
 * Reads the first sheet of an .xlsx workbook into rows of strings. Date cells
 * become `YYYY-MM-DD`, numeric cells become exact decimal strings (no float
 * artefacts, no scientific notation), text cells are returned verbatim.
 * Input is bounded by XLSX_LIMITS against zip bombs and sparse-sheet blowups.
 */
export function readXlsx(
  bytes: Uint8Array,
  options: ReadXlsxOptions = {},
): string[][] {
  if (bytes.length > XLSX_LIMITS.maxFileBytes) {
    throw new ImportFormatError("XLSX file is too large");
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new ImportFormatError(
      "File is a legacy .xls or encrypted workbook; save it as .xlsx or CSV",
    );
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ImportFormatError(
      "File is not an XLSX workbook (not a zip archive)",
    );
  }

  const sizes = new Map<string, number>();
  try {
    unzipSync(bytes, {
      filter: (f) => {
        sizes.set(f.name, f.originalSize);
        return false;
      },
    });
  } catch (cause) {
    throw new ImportFormatError("XLSX archive is corrupt", { cause });
  }

  const sheetCandidates = [...sizes.keys()]
    .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
    .sort();
  if (!sizes.has("xl/workbook.xml") || sheetCandidates.length === 0) {
    throw new ImportFormatError("XLSX workbook has no worksheet");
  }

  const workbookXml = unzipEntries(bytes, (n) => n === "xl/workbook.xml");
  const workbook = parseXml(workbookXml["xl/workbook.xml"]!, "workbook");
  const wbRoot = asNode(workbook["workbook"]);
  const date1904 = ["1", "true"].includes(
    String(asNode(wbRoot["workbookPr"])["@_date1904"] ?? ""),
  );
  const firstSheet = asNode(asArray(asNode(wbRoot["sheets"])["sheet"])[0]);
  const relId = firstSheet["@_id"];

  let sheetPath = sheetCandidates[0]!;
  if (typeof relId === "string" && sizes.has("xl/_rels/workbook.xml.rels")) {
    const relsXml = unzipEntries(
      bytes,
      (n) => n === "xl/_rels/workbook.xml.rels",
    );
    const rels = parseXml(
      relsXml["xl/_rels/workbook.xml.rels"]!,
      "relationships",
    );
    const rel = asArray(asNode(rels["Relationships"])["Relationship"])
      .map(asNode)
      .find((r) => r["@_Id"] === relId);
    const target = rel?.["@_Target"];
    if (typeof target === "string") {
      const path = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`;
      if (sizes.has(path)) sheetPath = path;
    }
  }

  const files = unzipEntries(
    bytes,
    (n) =>
      n === sheetPath || n === "xl/styles.xml" || n === "xl/sharedStrings.xml",
  );

  const sharedStrings: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    const sst = asNode(
      asNode(parseXml(files["xl/sharedStrings.xml"], "shared strings"))["sst"],
    );
    for (const si of asArray(sst["si"])) {
      sharedStrings.push(unescapeXlsxText(stringItemText(si)));
    }
  }

  const dateStyles = new Set<number>();
  if (files["xl/styles.xml"]) {
    const styleSheet = asNode(
      asNode(parseXml(files["xl/styles.xml"], "styles"))["styleSheet"],
    );
    const custom = new Map<number, string>();
    for (const nf of asArray(asNode(styleSheet["numFmts"])["numFmt"])) {
      const node = asNode(nf);
      custom.set(
        Number(node["@_numFmtId"]),
        String(node["@_formatCode"] ?? ""),
      );
    }
    asArray(asNode(styleSheet["cellXfs"])["xf"]).forEach((xf, index) => {
      const id = Number(asNode(xf)["@_numFmtId"] ?? 0);
      const code = custom.get(id);
      if (
        code !== undefined
          ? isDateFormatCode(code)
          : BUILTIN_DATE_FORMATS.has(id)
      ) {
        dateStyles.add(index);
      }
    });
  }

  const sheetText = strFromU8(files[sheetPath]!);
  checkSheetShape(sheetText);
  const sheet = asNode(asNode(parseXml(sheetText, "worksheet"))["worksheet"]);
  const sheetData = asNode(sheet["sheetData"]);
  const decimal = options.decimalSeparator ?? ".";
  const rows: string[][] = [];

  let nextRow = 0;
  for (const rowNode of asArray(sheetData["row"])) {
    const row = asNode(rowNode);
    const declared = row["@_r"];
    const rowIndex =
      typeof declared === "string" ? Number(declared) - 1 : nextRow;
    if (!Number.isInteger(rowIndex) || rowIndex < nextRow) {
      throw new ImportFormatError("XLSX worksheet has out-of-order rows");
    }
    if (rowIndex >= XLSX_LIMITS.maxRows) {
      throw new ImportFormatError(
        `XLSX worksheet exceeds ${XLSX_LIMITS.maxRows} rows`,
      );
    }
    while (rows.length < rowIndex) rows.push([]);
    const cells: string[] = [];
    let nextCol = 0;
    for (const cellNode of asArray(row["c"])) {
      const cell = asNode(cellNode);
      const ref = cell["@_r"];
      const col = typeof ref === "string" ? columnIndex(ref) : nextCol;
      if (col >= XLSX_LIMITS.maxColumns) {
        throw new ImportFormatError(
          `XLSX worksheet exceeds ${XLSX_LIMITS.maxColumns} columns`,
        );
      }
      nextCol = col + 1;
      while (cells.length < col) cells.push("");
      cells[col] = cellValue(
        cell,
        sharedStrings,
        dateStyles,
        date1904,
        decimal,
      );
    }
    rows.push(cells);
    nextRow = rowIndex + 1;
  }
  return rows;
}

function cellValue(
  cell: Node,
  sharedStrings: string[],
  dateStyles: Set<number>,
  date1904: boolean,
  decimal: "." | ",",
): string {
  const type = cell["@_t"];
  const raw = textOf(cell["v"]);
  if (type === "inlineStr") return unescapeXlsxText(stringItemText(cell["is"]));
  if (type === "s") {
    const s = sharedStrings[Number(raw)];
    if (s === undefined) {
      throw new ImportFormatError(
        `XLSX references missing shared string ${raw}`,
      );
    }
    return s;
  }
  if (type === "str" || type === "e") return unescapeXlsxText(raw);
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "d") return raw.slice(0, 10);
  if (raw.trim() === "") return "";
  const style = Number(cell["@_s"] ?? 0);
  if (dateStyles.has(style) && Number.isFinite(Number(raw))) {
    return serialToIsoDate(Number(raw), date1904);
  }
  const plain = numberToPlainString(raw);
  return decimal === "," ? plain.replace(".", ",") : plain;
}

function countMatches(text: string, re: RegExp): number {
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

/** Cheap element count before the XML is parsed into objects. */
function checkSheetShape(xml: string): void {
  const rows = countMatches(xml, /<(?:\w+:)?row[\s>/]/g);
  if (rows > XLSX_LIMITS.maxRows) {
    throw new ImportFormatError(
      `XLSX worksheet exceeds ${XLSX_LIMITS.maxRows} rows`,
    );
  }
  const cells = countMatches(xml, /<(?:\w+:)?c[\s>/]/g);
  if (cells > XLSX_LIMITS.maxRows * XLSX_LIMITS.maxColumns) {
    throw new ImportFormatError("XLSX worksheet has too many cells");
  }
}

function unzipEntries(
  bytes: Uint8Array,
  pick: (name: string) => boolean,
): Record<string, Uint8Array> {
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!pick(f.name)) return false;
        if (f.originalSize > XLSX_LIMITS.maxXmlBytes) {
          throw new ImportFormatError(
            `XLSX part ${f.name} is too large when uncompressed`,
          );
        }
        if (
          f.originalSize > XLSX_LIMITS.ratioCheckFromBytes &&
          f.originalSize > f.size * XLSX_LIMITS.maxCompressionRatio
        ) {
          throw new ImportFormatError(
            `XLSX part ${f.name} has a suspicious compression ratio`,
          );
        }
        total += f.originalSize;
        if (total > XLSX_LIMITS.maxXmlBytes) {
          throw new ImportFormatError("XLSX is too large when uncompressed");
        }
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof ImportFormatError) throw cause;
    throw new ImportFormatError("XLSX archive is corrupt", { cause });
  }
}
