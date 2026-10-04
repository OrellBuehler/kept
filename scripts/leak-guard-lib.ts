import { unzipSync } from "fflate";

const WORD = String.raw`[\p{L}\p{N}_]`;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;

export function normalizeText(value: string): string {
  return value.normalize("NFC").replace(ZERO_WIDTH, "");
}

export function collapseWhitespace(value: string): string {
  return normalizeText(value).replace(/\s+/gu, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
};

export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/gu,
    (
      match,
      dec: string | undefined,
      hex: string | undefined,
      name: string | undefined,
    ) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
      const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      if (!Number.isInteger(code) || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    },
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, whitespace-insensitive matcher for one term. The boundaries are
 * Unicode-aware, so terms that begin or end with an accented letter still match.
 */
export function termRegex(term: string): RegExp {
  return new RegExp(
    `(?<!${WORD})${escapeRegex(collapseWhitespace(term))}(?!${WORD})`,
    "iu",
  );
}

export function scanText(text: string, patterns: RegExp[]): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, index) => {
    const normalized = collapseWhitespace(line);
    if (patterns.some((regex) => regex.test(normalized))) hits.push(index + 1);
  });
  return hits;
}

export interface Finding {
  location: string;
  patternIndex: number;
  /** Set when the file could not be scanned within the limits; the scan must fail. */
  problem?: string;
}

export interface ScanLimits {
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
};

interface Budget {
  limits: ScanLimits;
  bytes: number;
  entries: number;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const MAX_ZIP_DEPTH = 3;

function isZip(buffer: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, i) => buffer[i] === byte);
}

function isMarkup(name: string): boolean {
  return /\.(xml|rels|html?|svg)$/iu.test(name);
}

function textVariants(name: string, text: string): string[] {
  if (!isMarkup(name)) return [text];
  // Spreadsheet cells and rich text split one phrase across tags.
  const variants = [
    text,
    text.replace(/<[^>]*>/gu, ""),
    text.replace(/<[^>]*>/gu, " "),
  ];
  return [...variants, ...variants.map(decodeXmlEntities)];
}

function scanBuffer(
  location: string,
  buffer: Uint8Array,
  patterns: RegExp[],
  warn: (message: string) => void,
  depth: number,
  budget: Budget,
): Finding[] {
  if (isZip(buffer) && depth < MAX_ZIP_DEPTH) {
    let entries: Record<string, Uint8Array>;
    const problems: Finding[] = [];
    const reject = (name: string, reason: string) =>
      problems.push({
        location: `${location}!${name}`,
        patternIndex: -1,
        problem: `${reason}; the file was not fully scanned`,
      });
    try {
      entries = unzipSync(buffer, {
        filter: (entry) => {
          const { limits } = budget;
          if (budget.entries + 1 > limits.maxEntries) {
            reject(
              entry.name,
              `archive entry count exceeds ${limits.maxEntries}`,
            );
            return false;
          }
          if (entry.originalSize > limits.maxEntryBytes) {
            reject(entry.name, `entry exceeds ${limits.maxEntryBytes} bytes`);
            return false;
          }
          if (budget.bytes + entry.originalSize > limits.maxTotalBytes) {
            reject(
              entry.name,
              `decompressed total exceeds ${limits.maxTotalBytes} bytes`,
            );
            return false;
          }
          budget.entries += 1;
          budget.bytes += entry.originalSize;
          return true;
        },
      });
    } catch (err) {
      warn(
        `leak-guard: ${location} looks like a zip archive but could not be read (${err instanceof Error ? err.message : String(err)}); skipped.`,
      );
      return problems;
    }
    return [
      ...problems,
      ...Object.entries(entries).flatMap(([name, data]) =>
        scanBuffer(
          `${location}!${name}`,
          data,
          patterns,
          warn,
          depth + 1,
          budget,
        ),
      ),
    ];
  }
  if (buffer.includes(0)) return [];
  const name = location.slice(location.lastIndexOf("!") + 1);
  const text = new TextDecoder().decode(buffer);
  const findings = new Map<string, Finding>();
  for (const variant of textVariants(name, text)) {
    patterns.forEach((regex, patternIndex) => {
      for (const line of scanText(variant, [regex])) {
        findings.set(`${line}:${patternIndex}`, {
          location: `${location}:${line}`,
          patternIndex,
        });
      }
    });
  }
  return [...findings.values()];
}

export function scanFile(
  file: string,
  buffer: Uint8Array,
  patterns: RegExp[],
  warn: (message: string) => void = console.warn,
  limits: ScanLimits = DEFAULT_LIMITS,
): Finding[] {
  return scanBuffer(file, buffer, patterns, warn, 0, {
    limits,
    bytes: 0,
    entries: 0,
  });
}
