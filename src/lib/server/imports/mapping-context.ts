import {
  countDataRows,
  detectColumns,
  previewTabular,
  type DetectedColumn,
  type PreviewRow,
} from "$lib/server/importers/csv";
import {
  DELIMITERS,
  ENCODINGS,
  type CsvMappingProfile,
  type CsvMappingProfileInput,
} from "$lib/server/importers/mapping";
import { readCsv, readXlsx } from "$lib/server/importers/tabular";
import { ImportFormatError } from "$lib/server/importers/types";
import { getAccount } from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { cachedParse } from "./cache";
import { getPendingMeta, readPending } from "./pending";
import { getCsvProfile, parseProfileSafe } from "./profiles";

export interface MappingContext {
  pendingId: string;
  fileName: string;
  format: "csv" | "xlsx";
  account: { id: string; name: string; currency: string };
  detected: DetectedColumn[];
  /** First 20 raw rows of the file. */
  sampleRows: string[][];
  /** Rows parsed with the profile, first 50 (invalid rows carry `error`). */
  preview: PreviewRow[];
  /** The profile that produced `preview`; null when the draft is invalid. */
  profile: CsvMappingProfile | null;
  /** What the mapping form should start with (saved profile, the draft, or a guess). */
  draft: CsvMappingProfileInput;
  /** Whether the draft came from the account's saved profile. */
  saved: boolean;
  savedName: string | null;
  rowCount: number;
  /** Rows below the header row, excluding blank lines and footer rows. */
  dataRowCount: number;
  /** Validation problems of the draft, or structural problems such as a missing column. */
  errors: string[];
}

const SAMPLE_ROWS = 20;
const PREVIEW_ROWS = 50;

const DATE_PATTERNS: [RegExp, NonNullable<CsvMappingProfile["dateFormat"]>][] =
  [
    [/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD"],
    [/^\d{1,2}\.\d{1,2}\.\d{4}/, "DD.MM.YYYY"],
    [/^\d{1,2}\.\d{1,2}\.\d{2}$/, "DD.MM.YY"],
    [/^\d{1,2}\/\d{1,2}\/\d{4}/, "DD/MM/YYYY"],
    [/^\d{8}$/, "YYYYMMDD"],
  ];

function dateFormatOf(sample: string) {
  return DATE_PATTERNS.find(([re]) => re.test(sample))?.[1];
}

/** A simple first guess: first date-like column, a named or numeric amount column, sample-based separators. */
export function guessProfile(
  rows: string[][],
  currency: string,
): CsvMappingProfileInput {
  const columns = detectColumns(rows, 1);
  const dateColumn = columns.find(
    (c) => c.samples.length > 0 && dateFormatOf(c.samples[0]!),
  );
  const amountColumn =
    columns.find((c) => /amount|betrag|montant|importo|saldo/i.test(c.name)) ??
    columns.find(
      (c) =>
        c !== dateColumn &&
        c.samples.length > 0 &&
        c.samples.every((s) => /^[-+(]?[\d.,' ]+\)?-?$/.test(s)),
    );
  const descriptionColumn = columns.find(
    (c) =>
      c !== dateColumn &&
      c !== amountColumn &&
      !/date|datum|valuta|amount|betrag|credit|debit|saldo|balance/i.test(
        c.name,
      ) &&
      /descr|text|purpose|memo|details|verwendung|mitteilung/i.test(c.name),
  );
  const amountSamples = amountColumn?.samples ?? [];
  const decimalComma = amountSamples.some((s) => /,\d{1,2}\)?-?$/.test(s));
  const thousands = amountSamples.some((s) => s.includes("'"))
    ? "'"
    : decimalComma && amountSamples.some((s) => /\d\.\d{3}/.test(s))
      ? "."
      : "";
  return {
    delimiter: "auto",
    encoding: "auto",
    headerRow: 1,
    dateFormat:
      (dateColumn && dateFormatOf(dateColumn.samples[0]!)) || "YYYY-MM-DD",
    decimalSeparator: decimalComma ? "," : ".",
    thousandsSeparator: thousands,
    amountMode: "single",
    defaultCurrency: currency,
    columns: {
      bookingDate: dateColumn?.name ?? "",
      ...(amountColumn ? { amount: amountColumn.name } : {}),
      ...(descriptionColumn ? { description: descriptionColumn.name } : {}),
    },
  } as CsvMappingProfileInput;
}

function pick<T extends readonly string[]>(
  options: T,
  value: unknown,
): T[number] | undefined {
  return typeof value === "string" &&
    (options as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Everything the mapping page needs: detected columns, raw sample rows and a
 * row-by-row preview of the draft (or saved) profile. `draftProfile` is
 * untrusted input and is validated here; an invalid draft yields
 * `profile: null`, `preview: []` and `errors`.
 */
export async function mappingContext(
  userId: string,
  pendingId: string,
  draftProfile?: unknown,
): Promise<MappingContext> {
  const meta = await getPendingMeta(userId, pendingId);
  const readBytes = async () => (await readPending(userId, pendingId)).bytes;
  if (meta.format === "camt053") {
    throw new LedgerError(
      "invalid",
      "camt.053 files need no column mapping.",
      "profile",
    );
  }
  const account = await getAccount(userId, meta.accountId);
  const saved = await getCsvProfile(userId, account.id);

  const draftObject =
    draftProfile === undefined ? null : plainObject(draftProfile);
  const errors: string[] = [];
  if (draftProfile !== undefined && draftObject === null) {
    errors.push("The profile must be an object.");
  }
  const source: Record<string, unknown> | null =
    draftObject ??
    (saved ? (saved.profile as unknown as Record<string, unknown>) : null);

  const delimiter = pick(DELIMITERS, source?.delimiter) ?? "auto";
  const encoding = pick(ENCODINGS, source?.encoding) ?? "auto";
  const decimalSeparator = source?.decimalSeparator === "," ? "," : ".";

  let rows: string[][] = [];
  try {
    rows =
      meta.format === "xlsx"
        ? await cachedParse(meta, `xlsx:${decimalSeparator}`, async () =>
            readXlsx(await readBytes(), { decimalSeparator }),
          )
        : await cachedParse(meta, `csv:${delimiter}:${encoding}`, async () =>
            readCsv(await readBytes(), { delimiter, encoding }),
          );
  } catch (err) {
    if (!(err instanceof ImportFormatError)) throw err;
    errors.push(err.message);
  }

  const draft: CsvMappingProfileInput =
    (source as CsvMappingProfileInput | null) ??
    guessProfile(rows, account.currency);

  let profile: CsvMappingProfile | null = null;
  let preview: PreviewRow[] = [];
  if (errors.length === 0) {
    const parsed = parseProfileSafe(draft);
    if (parsed.ok) {
      try {
        preview = previewTabular(rows, parsed.profile, { limit: PREVIEW_ROWS });
        profile = parsed.profile;
      } catch (err) {
        if (!(err instanceof ImportFormatError)) throw err;
        errors.push(err.message);
      }
    } else if (source !== null) {
      errors.push(...parsed.issues);
    }
  }

  const headerRow = Number.isInteger(source?.headerRow)
    ? (source!.headerRow as number)
    : 1;
  return {
    pendingId: meta.id,
    fileName: meta.fileName,
    format: meta.format,
    account: { id: account.id, name: account.name, currency: account.currency },
    detected: detectColumns(rows, Math.max(0, headerRow)),
    sampleRows: rows.slice(0, SAMPLE_ROWS),
    preview,
    profile,
    draft,
    saved: draftObject === null && saved !== null,
    savedName: saved?.name ?? null,
    rowCount: rows.length,
    dataRowCount: countDataRows(
      rows,
      Math.max(0, headerRow),
      Number.isInteger(source?.skipFooterRows) &&
        (source!.skipFooterRows as number) > 0
        ? (source!.skipFooterRows as number)
        : 0,
    ),
    errors,
  };
}
