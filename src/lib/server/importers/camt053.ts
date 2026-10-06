import { parseCamtDocument } from "./iso20022";
import type { NormalizedStatement } from "./types";

/**
 * ISO 20022 camt.053 (bank-to-customer statement) importer. The entry parsing, sign,
 * reversal, batch and externalId rules are documented in `iso20022.ts`.
 */
export function parseCamt053(xml: string): NormalizedStatement[] {
  return parseCamtDocument(xml, {
    message: "camt.053",
    container: "BkToCstmrStmt",
    item: "Stmt",
  });
}
