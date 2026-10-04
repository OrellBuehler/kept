import { unzipSync } from "fflate";

const WORD = String.raw`[\p{L}\p{N}_]`;

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
  return [text, text.replace(/<[^>]*>/gu, ""), text.replace(/<[^>]*>/gu, " ")];
}

function scanBuffer(
  location: string,
  buffer: Uint8Array,
  patterns: RegExp[],
  warn: (message: string) => void,
  depth: number,
): Finding[] {
  if (isZip(buffer) && depth < MAX_ZIP_DEPTH) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buffer);
    } catch (err) {
      warn(
        `leak-guard: ${location} looks like a zip archive but could not be read (${err instanceof Error ? err.message : String(err)}); skipped.`,
      );
      return [];
    }
    return Object.entries(entries).flatMap(([name, data]) =>
      scanBuffer(`${location}!${name}`, data, patterns, warn, depth + 1),
    );
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
): Finding[] {
  return scanBuffer(file, buffer, patterns, warn, 0);
}
