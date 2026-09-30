import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { CsvMappingProfileInput } from "$lib/server/importers/mapping";
import { storePending } from "$lib/server/imports/pending";
import { fixture } from "./fixtures";

/**
 * Points the pending-upload store at a fresh temp directory for every test
 * (it lives next to DATABASE_PATH). Call once at the top level of a test file.
 */
export function usePendingDir(): { readonly dir: string } {
  let dir = "";
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.DATABASE_PATH;
    dir = mkdtempSync(join(tmpdir(), "kept-pending-"));
    process.env.DATABASE_PATH = join(dir, "kept.db");
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get dir() {
      return dir;
    },
  };
}

/** Stores a synthetic fixture as a pending upload and returns its id. */
export function uploadFixture(
  userId: string,
  accountId: string,
  path: string,
  fileName = path.split("/").pop()!,
): string {
  return storePending(userId, {
    accountId,
    fileName,
    bytes: fixture(path),
  }).id;
}

/** Mapping for the simple synthetic csv/xlsx fixtures (Date, Counterparty, Description, Amount, Currency). */
export const SIMPLE_CSV_PROFILE: CsvMappingProfileInput = {
  amountMode: "single",
  dateFormat: "YYYY-MM-DD",
  decimalSeparator: ".",
  columns: {
    bookingDate: "Date",
    amount: "Amount",
    currency: "Currency",
    counterpartyName: "Counterparty",
    description: "Description",
  },
};

export function uploadBytes(
  userId: string,
  accountId: string,
  bytes: Uint8Array,
  fileName = "upload.xml",
): string {
  return storePending(userId, { accountId, fileName, bytes }).id;
}

/** Mapping for csv/bad-rows.csv (Date, Text, Amount; no currency column). */
export const BAD_ROWS_PROFILE: CsvMappingProfileInput = {
  amountMode: "single",
  dateFormat: "YYYY-MM-DD",
  decimalSeparator: ".",
  defaultCurrency: "CHF",
  columns: { bookingDate: "Date", amount: "Amount", description: "Text" },
};
