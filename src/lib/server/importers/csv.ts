import { createHash } from "node:crypto";
import { currencyExponent, minor, parseAmount, type Minor } from "$lib/money";
import type { ColumnRef, CsvMappingProfile } from "./mapping";
import { detectReference } from "$lib/references";
import { readCsv, readXlsx } from "./tabular";
import {
  ImportFormatError,
  type NormalizedBalance,
  type NormalizedStatement,
  type NormalizedTransaction,
} from "./types";

export interface PreviewRow {
  /** 1-based index of the record in the file (a quoted multi-line field is still one record). */
  rowNumber: number;
  raw: string[];
  transaction?: NormalizedTransaction;
  error?: string;
}

export interface DetectedColumn {
  index: number;
  name: string;
  samples: string[];
}

export interface RowError {
  rowNumber: number;
  message: string;
}

/** Thrown by parseTabular when at least one data row is invalid. */
function describeRowErrors(errors: RowError[], total: number): string {
  const shown = errors.map((e) => `row ${e.rowNumber}: ${e.message}`);
  const more = total - errors.length;
  return `${total} row${total === 1 ? "" : "s"} could not be parsed (${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""})`;
}

/** Thrown by parseTabular when at least one data row is invalid. */
export class ImportRowsError extends ImportFormatError {
  override name = "ImportRowsError";
  readonly rowErrors: RowError[];
  readonly totalErrors: number;
  constructor(rowErrors: RowError[], totalErrors: number) {
    super(describeRowErrors(rowErrors, totalErrors));
    this.rowErrors = rowErrors;
    this.totalErrors = totalErrors;
  }
}

const MAX_REPORTED_ROW_ERRORS = 10;

class RowProblem extends Error {}

type ColumnKey = keyof CsvMappingProfile["columns"];
type ResolvedColumns = Partial<Record<ColumnKey, number[]>>;

interface Layout {
  columns: ResolvedColumns;
  dataStart: number;
  dataEnd: number;
}

const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();
const normalizeHeader = (s: string) => normalizeText(s).toLowerCase();

function isBlank(row: string[]): boolean {
  return row.every((c) => c.trim() === "");
}

function resolveRef(
  ref: ColumnRef,
  key: string,
  header: string[] | null,
  headerRow: number,
): number {
  if (typeof ref === "number") return ref;
  if (header === null) {
    if (/^\d+$/.test(ref)) return Number(ref);
    throw new ImportFormatError(
      `Column "${ref}" (${key}) is addressed by name but the profile has no header row`,
    );
  }
  const exact = header.findIndex(
    (h) => normalizeText(h) === normalizeText(ref),
  );
  const index =
    exact >= 0
      ? exact
      : header.findIndex((h) => normalizeHeader(h) === normalizeHeader(ref));
  if (index < 0) {
    throw new ImportFormatError(
      `Column "${ref}" (${key}) not found in header row ${headerRow}; available columns: ${header
        .map((h) => `"${normalizeText(h)}"`)
        .join(", ")}`,
    );
  }
  return index;
}

function layoutOf(rows: string[][], profile: CsvMappingProfile): Layout {
  const { headerRow } = profile;
  if (rows.length === 0) throw new ImportFormatError("File is empty");
  if (headerRow > rows.length) {
    throw new ImportFormatError(
      `Header row ${headerRow} is beyond the end of the file (${rows.length} rows)`,
    );
  }
  const header = headerRow > 0 ? rows[headerRow - 1]! : null;
  const columns: ResolvedColumns = {};
  for (const [key, value] of Object.entries(profile.columns)) {
    if (value === undefined) continue;
    const refs = Array.isArray(value) ? value : [value];
    columns[key as ColumnKey] = refs.map((r) =>
      resolveRef(r, `columns.${key}`, header, headerRow),
    );
  }

  let dataEnd = rows.length;
  let toSkip = profile.skipFooterRows;
  while (dataEnd > headerRow) {
    const row = rows[dataEnd - 1]!;
    if (isBlank(row)) {
      dataEnd--;
    } else if (toSkip > 0) {
      toSkip--;
      dataEnd--;
    } else {
      break;
    }
  }
  return { columns, dataStart: headerRow, dataEnd };
}

function parseDate(text: string, profile: CsvMappingProfile): string {
  const time = String.raw`(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?`;
  const patterns: Record<
    CsvMappingProfile["dateFormat"],
    { re: RegExp; order: "ymd" | "dmy" | "mdy"; short?: boolean }
  > = {
    "YYYY-MM-DD": {
      re: new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})${time}$`),
      order: "ymd",
    },
    "DD.MM.YYYY": {
      re: new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})\.(\d{4})${time}$`),
      order: "dmy",
    },
    "DD/MM/YYYY": {
      re: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${time}$`),
      order: "dmy",
    },
    "MM/DD/YYYY": {
      re: new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${time}$`),
      order: "mdy",
    },
    "DD.MM.YY": {
      re: new RegExp(String.raw`^(\d{1,2})\.(\d{1,2})\.(\d{2})${time}$`),
      order: "dmy",
      short: true,
    },
    YYYYMMDD: { re: /^(\d{4})(\d{2})(\d{2})$/, order: "ymd" },
  };

  const build = (
    a: string,
    b: string,
    c: string,
    order: string,
    short = false,
  ) => {
    let y: number, m: number, d: number;
    if (order === "ymd")
      [y, m, d] = [Number(a), Number(b), Number(c)] as [number, number, number];
    else if (order === "dmy")
      [d, m, y] = [Number(a), Number(b), Number(c)] as [number, number, number];
    else
      [m, d, y] = [Number(a), Number(b), Number(c)] as [number, number, number];
    if (short) y = y < profile.twoDigitYearPivot ? 2000 + y : 1900 + y;
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (
      m < 1 ||
      m > 12 ||
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== m - 1 ||
      probe.getUTCDate() !== d
    ) {
      return null;
    }
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };

  const p = patterns[profile.dateFormat];
  let match = p.re.exec(text);
  if (match) {
    const out = build(match[1]!, match[2]!, match[3]!, p.order, p.short);
    if (out) return out;
    throw new RowProblem(`"${text}" is not a real calendar date`);
  }
  // ISO dates are unambiguous; XLSX date cells arrive in this form whatever the profile says.
  match = patterns["YYYY-MM-DD"].re.exec(text);
  if (match) {
    const out = build(match[1]!, match[2]!, match[3]!, "ymd");
    if (out) return out;
    throw new RowProblem(`"${text}" is not a real calendar date`);
  }
  throw new RowProblem(
    `"${text}" does not match the date format ${profile.dateFormat}`,
  );
}

function parseLocalizedAmount(
  text: string,
  profile: CsvMappingProfile,
  decimals: number,
): Minor {
  let s = text
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\u2019/g, "'")
    .trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  } else if (s.endsWith("-") && !s.startsWith("-") && !s.startsWith("+")) {
    negative = true;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  const dec = profile.decimalSeparator;
  const thousands = profile.thousandsSeparator;
  const [whole = "", fraction, ...rest] = s.split(dec);
  if (
    rest.length > 0 ||
    (whole === "" && (fraction === undefined || fraction === "")) ||
    (fraction !== undefined && !/^\d+$/.test(fraction))
  ) {
    throw new RowProblem("not a valid number");
  }
  let digits = whole === "" ? "0" : whole;
  if (thousands !== "" && whole.includes(thousands)) {
    const grouped = new RegExp(
      `^\\d{1,3}(?:${thousands.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{3})+$`,
    );
    if (!grouped.test(whole)) throw new RowProblem("not a valid number");
    digits = whole.split(thousands).join("");
  }
  if (!/^\d+$/.test(digits)) throw new RowProblem("not a valid number");

  let frac = fraction ?? "";
  if (frac.length > decimals) {
    if (/[1-9]/.test(frac.slice(decimals))) {
      throw new RowProblem(`has more than ${decimals} decimal places`);
    }
    frac = frac.slice(0, decimals);
  }
  let value: Minor;
  try {
    value = parseAmount(`${digits}${frac ? `.${frac}` : ""}`, decimals);
  } catch (e) {
    if (e instanceof RangeError || e instanceof SyntaxError) {
      throw new RowProblem("not a valid number");
    }
    throw e;
  }
  return negate(value, negative);
}

function negate(value: Minor, when: boolean): Minor {
  return when && value !== 0 ? minor(-value) : value;
}

function abs(value: Minor): Minor {
  return value < 0 ? minor(-value) : value;
}

function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    remainder = Number(`${remainder}${code}`) % 97;
  }
  return remainder === 1;
}

interface ParsedRow {
  fields: Omit<NormalizedTransaction, "externalId">;
  providedId: string | null;
  balance: Minor | null;
}

function parseRow(
  row: string[],
  cols: ResolvedColumns,
  profile: CsvMappingProfile,
): ParsedRow {
  const cell = (key: ColumnKey): string => {
    const idx = cols[key]?.[0];
    return idx === undefined ? "" : normalizeText(row[idx] ?? "");
  };
  const amountCell = (key: ColumnKey, decimals: number): Minor | null => {
    const text = cell(key);
    if (text === "") return null;
    try {
      return parseLocalizedAmount(text, profile, decimals);
    } catch (e) {
      // Fixed messages only: never echo the cell value.
      if (e instanceof RowProblem) {
        throw new RowProblem(
          `${key} column is not a valid amount (${e.message})`,
        );
      }
      if (e instanceof RangeError || e instanceof SyntaxError) {
        throw new RowProblem(`${key} column is not a valid amount`);
      }
      throw e;
    }
  };
  const need = (key: ColumnKey, decimals: number): Minor => {
    const v = amountCell(key, decimals);
    if (v === null) throw new RowProblem(`${key} column is empty`);
    return v;
  };
  const dateCell = (key: ColumnKey, required: boolean): string | null => {
    const text = cell(key);
    if (text === "") {
      if (required) throw new RowProblem(`${key} is empty`);
      return null;
    }
    try {
      return parseDate(text, profile);
    } catch (e) {
      if (e instanceof RowProblem) throw new RowProblem(`${key} ${e.message}`);
      throw e;
    }
  };

  const bookingDate = dateCell("bookingDate", true)!;
  const valueDate = dateCell("valueDate", false);

  const currencyText = cell("currency").toUpperCase();
  const currency = currencyText || profile.defaultCurrency;
  if (!currency)
    throw new RowProblem("currency is empty and no defaultCurrency is set");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RowProblem(`currency "${currencyText}" is not a 3-letter code`);
  }

  const exp = currencyExponent(currency);

  let amount: Minor;
  if (profile.amountMode === "single") {
    amount = need("amount", exp);
  } else if (profile.amountMode === "single_with_indicator") {
    const magnitude = abs(need("amount", exp));
    const indicator = cell("indicator").toUpperCase();
    const isCredit = profile.indicatorCreditValues.some(
      (v) => v.toUpperCase() === indicator,
    );
    const isDebit = profile.indicatorDebitValues.some(
      (v) => v.toUpperCase() === indicator,
    );
    if (isCredit === isDebit) {
      throw new RowProblem(
        indicator === ""
          ? "indicator is empty"
          : `indicator "${cell("indicator")}" is not configured as credit or debit`,
      );
    }
    amount = negate(magnitude, isDebit);
  } else {
    const credit = amountCell("credit", exp);
    const debit = amountCell("debit", exp);
    if (credit === null && debit === null) {
      throw new RowProblem("both credit and debit are empty");
    }
    if ((credit ?? 0) !== 0 && (debit ?? 0) !== 0) {
      throw new RowProblem("both credit and debit are filled");
    }
    amount = minor(abs(credit ?? (0 as Minor)) - abs(debit ?? (0 as Minor)));
  }
  if (profile.invertSign) amount = negate(amount, true);

  let originalAmount: Minor | null = null;
  let originalCurrency: string | null = null;
  const origAmountText = cell("originalAmount");
  const origCurrencyText = cell("originalCurrency").toUpperCase();
  if (origAmountText !== "" || origCurrencyText !== "") {
    if (origAmountText === "" || origCurrencyText === "") {
      throw new RowProblem(
        "originalAmount and originalCurrency must both be filled",
      );
    }
    if (!/^[A-Z]{3}$/.test(origCurrencyText)) {
      throw new RowProblem(
        `originalCurrency "${origCurrencyText}" is not a 3-letter code`,
      );
    }
    // The original amount takes the direction of the booked amount; the exports carry it unsigned.
    const magnitude = abs(
      need("originalAmount", currencyExponent(origCurrencyText)),
    );
    originalAmount = negate(magnitude, amount < 0);
    originalCurrency = origCurrencyText;
  }

  const ibanText = cell("counterpartyIban").replace(/\s+/g, "").toUpperCase();
  if (ibanText !== "" && !isValidIban(ibanText)) {
    throw new RowProblem("counterpartyIban is not a valid IBAN");
  }

  const description = (cols.description ?? [])
    .map((idx) => normalizeText(row[idx] ?? ""))
    .filter((t) => t !== "")
    .join(" / ");

  const referenceText = cell("reference");
  const ref = referenceText ? detectReference(referenceText) : null;
  const rawBalance = amountCell("balance", exp);
  const balance =
    rawBalance !== null && profile.invertSign
      ? negate(rawBalance, true)
      : rawBalance;
  const provided = cell("externalId");

  return {
    fields: {
      bookingDate,
      valueDate,
      amount,
      currency,
      originalAmount,
      originalCurrency,
      counterpartyName: cell("counterpartyName") || null,
      counterpartyIban: ibanText || null,
      description: description || null,
      reference: ref?.reference ?? null,
      referenceType: ref?.referenceType ?? null,
      reversal: false,
    },
    providedId: provided || null,
    balance,
  };
}

/**
 * Stable id for a row without a bank reference: SHA-256 over the normalized
 * booking data (never the row position, balance or any export-specific
 * column), so the same booking hashes identically in every export that
 * contains it, whatever the file, ordering or neighbouring rows.
 *
 * Rows that are identical in every field (two coffees, same day, same price)
 * are told apart by an occurrence counter `#n` within the file. Overlapping
 * exports stay consistent because an identical-row group sits on a single
 * booking date: any export that covers that day contains the whole group, so
 * the n-th copy gets the same suffix in both files. Only a file that cuts a
 * day in half can shift the numbering of that day's duplicates.
 * A bank reference repeated within one file is disambiguated the same way
 * (first occurrence keeps the bare id, later ones get `#2`, `#3`, ...).
 * `%` and `#` inside a provided reference are percent-escaped so the suffix
 * can never be confused with part of a reference.
 */
class ExternalIdAllocator {
  private seen = new Map<string, number>();

  allocate(parsed: ParsedRow): string {
    if (parsed.providedId) {
      const base = `ref:${parsed.providedId.replace(/[%#]/g, (c) => (c === "%" ? "%25" : "%23"))}`;
      const n = this.bump(base);
      return n === 1 ? base : `${base}#${n}`;
    }
    const f = parsed.fields;
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          f.bookingDate,
          f.valueDate,
          f.amount,
          f.currency,
          f.counterpartyName,
          f.counterpartyIban,
          f.description,
          f.reference,
        ]),
      )
      .digest("hex");
    const base = `hash:${digest}`;
    return `${base}#${this.bump(base)}`;
  }

  private bump(key: string): number {
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    return n;
  }
}

interface AnalyzedRow extends PreviewRow {
  balance: Minor | null;
}

function analyze(
  rows: string[][],
  profile: CsvMappingProfile,
  limit = Infinity,
): AnalyzedRow[] {
  const layout = layoutOf(rows, profile);
  const ids = new ExternalIdAllocator();
  const out: AnalyzedRow[] = [];
  for (
    let i = layout.dataStart;
    i < layout.dataEnd && out.length < limit;
    i++
  ) {
    const raw = rows[i]!;
    if (isBlank(raw)) continue;
    const base = { rowNumber: i + 1, raw, balance: null };
    try {
      const parsed = parseRow(raw, layout.columns, profile);
      out.push({
        ...base,
        balance: parsed.balance,
        transaction: { externalId: ids.allocate(parsed), ...parsed.fields },
      });
    } catch (e) {
      if (!(e instanceof RowProblem)) throw e;
      out.push({ ...base, error: e.message });
    }
  }
  return out;
}

/**
 * Row-by-row parse for a live mapping preview. Invalid rows carry `error`
 * instead of throwing. Structural problems (missing columns, unreadable
 * header row) still throw ImportFormatError. `limit` counts non-blank data rows.
 */
export function previewTabular(
  rows: string[][],
  profile: CsvMappingProfile,
  options: { limit?: number } = {},
): PreviewRow[] {
  return analyze(rows, profile, options.limit).map(
    ({ rowNumber, raw, transaction, error }) => ({
      rowNumber,
      raw,
      ...(transaction ? { transaction } : {}),
      ...(error ? { error } : {}),
    }),
  );
}

interface BalanceItem {
  tx: NormalizedTransaction;
  balance: Minor | null;
}

/**
 * Opening and closing balance of the rows of one booking date, in whichever of
 * file order / reversed file order the running balance actually chains
 * (previous balance + amount = balance). Null when it cannot be verified
 * or both directions chain to different results: no guessing.
 */
function verifiedChain(
  group: BalanceItem[],
): { start: Minor; end: Minor } | null {
  if (group.some((i) => i.balance === null)) return null;
  const results: { start: Minor; end: Minor }[] = [];
  for (const order of [group, [...group].reverse()]) {
    let ok = true;
    for (let k = 1; k < order.length && ok; k++) {
      ok = order[k - 1]!.balance! + order[k]!.tx.amount === order[k]!.balance;
    }
    if (!ok) continue;
    const head = order[0]!;
    results.push({
      start: minor(head.balance! - head.tx.amount),
      end: order[order.length - 1]!.balance!,
    });
  }
  const first = results[0];
  if (!first) return null;
  return results.every((r) => r.start === first.start && r.end === first.end)
    ? first
    : null;
}

/**
 * Parses the whole table. Blank lines and configured footer rows are
 * skipped; any other row that fails makes this throw ImportRowsError (no
 * partial results). Opening/closing balances are derived only when a balance
 * column is mapped: among the rows of the earliest (latest) booking date the
 * running balance chain is verified, in either file direction; opening is
 * the first row's balance minus its amount, closing the last row's balance.
 * If the chain cannot be verified the balance is null. Balance dates are
 * those booking dates. With `invertSign`, balances are inverted as well.
 */
export function parseTabular(
  rows: string[][],
  profile: CsvMappingProfile,
): NormalizedStatement {
  const analyzed = analyze(rows, profile);
  const failed = analyzed.filter((r) => r.error !== undefined);
  if (failed.length > 0) {
    throw new ImportRowsError(
      failed.slice(0, MAX_REPORTED_ROW_ERRORS).map((r) => ({
        rowNumber: r.rowNumber,
        message: r.error!,
      })),
      failed.length,
    );
  }

  const items = analyzed.map((r) => ({
    tx: r.transaction!,
    balance: r.balance,
  }));
  const currencies = [...new Set(items.map((i) => i.tx.currency))];
  if (currencies.length > 1) {
    throw new ImportFormatError(
      `File mixes currencies (${currencies.join(", ")}); import one currency per file or use originalAmount/originalCurrency for foreign amounts`,
    );
  }
  // "XXX" is the ISO 4217 code for "no currency": an empty file with no defaultCurrency.
  const currency = currencies[0] ?? profile.defaultCurrency ?? "XXX";

  let openingBalance: NormalizedBalance | null = null;
  let closingBalance: NormalizedBalance | null = null;
  if (profile.columns.balance !== undefined && items.length > 0) {
    const all = items.map((i) => i.tx.bookingDate).sort();
    const from = all[0]!;
    const to = all[all.length - 1]!;
    const opening = verifiedChain(
      items.filter((i) => i.tx.bookingDate === from),
    );
    const closing = verifiedChain(items.filter((i) => i.tx.bookingDate === to));
    if (opening)
      openingBalance = { amount: opening.start, currency, date: from };
    if (closing) closingBalance = { amount: closing.end, currency, date: to };
  }

  const dates = items.map((i) => i.tx.bookingDate).sort();
  return {
    accountIban: null,
    accountOtherId: null,
    currency,
    statementId: null,
    fromDate: dates[0] ?? null,
    toDate: dates[dates.length - 1] ?? null,
    openingBalance,
    closingBalance,
    transactions: items.map((i) => i.tx),
  };
}

/**
 * Header names and sample values per column to drive a mapping UI. With
 * `headerRow` 0 the columns are named "Column 1", "Column 2", ...
 */
export function detectColumns(
  rows: string[][],
  headerRow: number,
  options: { sampleSize?: number; scanRows?: number } = {},
): DetectedColumn[] {
  const sampleSize = options.sampleSize ?? 3;
  const scanEnd = Math.min(rows.length, headerRow + (options.scanRows ?? 200));
  if (headerRow > rows.length) return [];
  const header = headerRow > 0 ? rows[headerRow - 1]! : [];
  let width = header.length;
  for (let i = headerRow; i < scanEnd; i++)
    width = Math.max(width, rows[i]!.length);

  const columns: DetectedColumn[] = [];
  for (let index = 0; index < width; index++) {
    const samples: string[] = [];
    for (let i = headerRow; i < scanEnd && samples.length < sampleSize; i++) {
      const value = normalizeText(rows[i]![index] ?? "");
      if (value !== "" && !samples.includes(value)) samples.push(value);
    }
    const name = normalizeText(header[index] ?? "");
    columns.push({
      index,
      name: headerRow > 0 && name !== "" ? name : `Column ${index + 1}`,
      samples,
    });
  }
  return columns;
}

export function parseCsvFile(
  bytes: Uint8Array,
  profile: CsvMappingProfile,
): NormalizedStatement {
  return parseTabular(
    readCsv(bytes, {
      delimiter: profile.delimiter,
      encoding: profile.encoding,
    }),
    profile,
  );
}

export function parseXlsxFile(
  bytes: Uint8Array,
  profile: CsvMappingProfile,
): NormalizedStatement {
  return parseTabular(
    readXlsx(bytes, { decimalSeparator: profile.decimalSeparator }),
    profile,
  );
}
