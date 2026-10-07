import type { ImportFormat } from "$lib/ledger-types";
import { parseCamt053 } from "$lib/server/importers/camt053";
import { parseCamt054 } from "$lib/server/importers/camt054";
import { parseMt940 } from "$lib/server/importers/mt940";
import { decodeText } from "$lib/server/importers/tabular";
import type { NormalizedStatement } from "$lib/server/importers/types";

export const STATEMENT_FORMATS = ["camt053", "camt054", "mt940"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

/**
 * Formats that name their account and carry their own structure (as opposed to csv/xlsx,
 * which need a column mapping and an account chosen by the user).
 */
export function isStatementFormat(
  format: ImportFormat,
): format is StatementFormat {
  return (STATEMENT_FORMATS as readonly string[]).includes(format);
}

/**
 * Parses the bytes of a camt.053, camt.054 or MT940 file. camt is XML read as UTF-8; MT940 is
 * decoded like a CSV with automatic encoding: a byte order mark or UTF-16 is honoured, valid
 * UTF-8 is used as is and anything else is read as windows-1252.
 */
export function parseStatementFile(
  format: StatementFormat,
  bytes: Uint8Array,
): NormalizedStatement[] {
  switch (format) {
    case "camt053":
      return parseCamt053(new TextDecoder("utf-8").decode(bytes));
    case "camt054":
      return parseCamt054(new TextDecoder("utf-8").decode(bytes));
    case "mt940":
      return parseMt940(decodeText(bytes));
  }
}
