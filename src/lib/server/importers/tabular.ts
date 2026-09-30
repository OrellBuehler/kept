import { ImportFormatError } from "./types";
import type { CsvMappingProfile } from "./mapping";

export { readXlsx } from "./xlsx";

type Encoding = CsvMappingProfile["encoding"];
type Delimiter = Exclude<CsvMappingProfile["delimiter"], "auto">;

const CANDIDATE_DELIMITERS: Delimiter[] = [";", ",", "\t", "|"];

function swapBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i < out.length; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  return out;
}

/**
 * UTF-16 without BOM: mostly-ASCII text has a NUL in every second byte, which
 * never occurs in UTF-8 or single-byte text.
 */
function guessUtf16(bytes: Uint8Array): "le" | "be" | null {
  const n = Math.min(bytes.length, 4000) & ~1;
  if (n < 4) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenNul++;
    if (bytes[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  if (oddNul > pairs * 0.3 && evenNul === 0) return "le";
  if (evenNul > pairs * 0.3 && oddNul === 0) return "be";
  return null;
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new ImportFormatError(
      "File is not valid UTF-8; set the encoding to windows-1252 or iso-8859-1",
      { cause },
    );
  }
}

/**
 * Decodes file bytes to text and strips a leading byte order mark.
 * `auto` honours a BOM (UTF-8, UTF-16 LE/BE), otherwise tries strict UTF-8 and
 * falls back to windows-1252 when the bytes are not valid UTF-8.
 * Note: `iso-8859-1` is decoded as true Latin-1 (bytes 0x80-0x9F stay control
 * characters), unlike the WHATWG label which aliases it to windows-1252.
 */
export function decodeText(
  bytes: Uint8Array,
  encoding: Encoding = "auto",
): string {
  let text: string;
  const b = bytes;
  const hasLeBom = b[0] === 0xff && b[1] === 0xfe;
  const hasBeBom = b[0] === 0xfe && b[1] === 0xff;

  if (encoding === "auto") {
    if (hasLeBom) {
      text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(b);
    } else if (hasBeBom) {
      text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(
        swapBytes(b),
      );
    } else if (guessUtf16(b) === "le") {
      text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(b);
    } else if (guessUtf16(b) === "be") {
      text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(
        swapBytes(b),
      );
    } else {
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(b);
      } catch {
        // Not UTF-8: legacy single-byte export, the overwhelmingly common case.
        text = new TextDecoder("windows-1252").decode(b);
      }
    }
  } else if (encoding === "utf-8") {
    text = decodeStrictUtf8(b);
  } else if (encoding === "utf-16le") {
    text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(b);
  } else if (encoding === "windows-1252") {
    text = new TextDecoder("windows-1252").decode(b);
  } else {
    let s = "";
    for (let i = 0; i < b.length; i += 8192) {
      s += String.fromCharCode(...b.subarray(i, i + 8192));
    }
    text = s;
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC 4180 parser. Quotes are special only at the start of a field, `""`
 * inside a quoted field is a literal quote, quoted fields may contain
 * delimiters and line breaks. Records end at CRLF, LF or CR. A trailing line
 * break does not produce an extra record; blank lines yield `[""]`.
 */
export function parseCsvText(
  text: string,
  delimiter: Delimiter,
  maxRecords = Infinity,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  let quoteStartRecord = 0;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStart = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    if (rows.length >= maxRecords) return rows;
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      quoteStartRecord = rows.length + 1;
      i++;
    } else if (ch === delimiter) {
      endField();
      i++;
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      fieldStart = false;
      i++;
    }
  }
  if (inQuotes) {
    throw new ImportFormatError(
      `Unterminated quoted field starting in record ${quoteStartRecord}`,
    );
  }
  if (field !== "" || row.length > 0 || !fieldStart) endRow();
  return rows;
}

/**
 * Picks the delimiter that splits the first records into the most consistent
 * number of fields (more columns win ties). Falls back to a comma.
 */
export function detectDelimiter(text: string): Delimiter {
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    let records: string[][];
    try {
      records = parseCsvText(text, candidate, 30);
    } catch {
      // An unbalanced quote for this candidate only disqualifies it; real
      // structural errors are reported when the file is parsed for real.
      continue;
    }
    const counts = new Map<number, number>();
    for (const r of records) {
      if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    }
    for (const [width, freq] of counts) {
      const score = freq * 1000 + width;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best;
}

export function readCsv(
  bytes: Uint8Array,
  options: {
    delimiter?: CsvMappingProfile["delimiter"];
    encoding?: Encoding;
  } = {},
): string[][] {
  const text = decodeText(bytes, options.encoding ?? "auto");
  const requested = options.delimiter ?? "auto";
  const delimiter = requested === "auto" ? detectDelimiter(text) : requested;
  return parseCsvText(text, delimiter);
}
