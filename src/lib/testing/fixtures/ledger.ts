import {
  BAD_IBAN_CHECK,
  EXAMPLE_IBAN,
  FOREIGN_IBANS,
} from "./bill-identifiers";

/** Documented example identifiers for ledger tests (synthetic). */
export const LEDGER_IBAN_A = EXAMPLE_IBAN;
export const LEDGER_IBAN_A_SPACED = "ch93 0076 2011 6238 5295 7";
export const LEDGER_IBAN_B = FOREIGN_IBANS[0]!;
export const LEDGER_IBAN_BAD_CHECKSUM = BAD_IBAN_CHECK;
export const LEDGER_BIC_8 = "AAAACHZZ";
export const LEDGER_BIC_11 = "AAAACHZZXXX";
