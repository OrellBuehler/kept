import type { CsvMappingProfileInput } from "$lib/server/importers/mapping";
import { storePending } from "$lib/server/imports/pending";
import { fixture } from "./fixtures";

/** Stores a synthetic fixture as a pending upload and returns its id. */
export async function uploadFixture(
  userId: string,
  accountId: string,
  path: string,
  fileName = path.split("/").pop()!,
): Promise<string> {
  return (
    await storePending(userId, {
      accountId,
      fileName,
      bytes: fixture(path),
    })
  ).id;
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

export async function uploadBytes(
  userId: string,
  accountId: string,
  bytes: Uint8Array,
  fileName = "upload.xml",
): Promise<string> {
  return (await storePending(userId, { accountId, fileName, bytes })).id;
}

/** Mapping for csv/bad-rows.csv (Date, Text, Amount; no currency column). */
export const BAD_ROWS_PROFILE: CsvMappingProfileInput = {
  amountMode: "single",
  dateFormat: "YYYY-MM-DD",
  decimalSeparator: ".",
  defaultCurrency: "CHF",
  columns: { bookingDate: "Date", amount: "Amount", description: "Text" },
};
