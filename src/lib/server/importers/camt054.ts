import { parseCamtDocument } from "./iso20022";
import type { NormalizedStatement } from "./types";

/**
 * ISO 20022 camt.054 (bank-to-customer debit/credit notification) importer: camt.054.001.02,
 * .04, .08 and any other .001.NN (elements are read by meaning).
 *
 * A notification reports individual bookings, usually without balances: each `Ntfctn` becomes
 * one statement with `openingBalance` and `closingBalance` null (nothing is fabricated).
 * Entries are parsed by the same code as camt.053 (`iso20022.ts`), so a booking carries the
 * same `externalId` whether it arrives in a statement or in a notification.
 */
export function parseCamt054(xml: string): NormalizedStatement[] {
  return parseCamtDocument(xml, {
    message: "camt.054",
    container: "BkToCstmrDbtCdtNtfctn",
    item: "Ntfctn",
  });
}
