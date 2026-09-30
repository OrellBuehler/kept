import type { ReferenceType } from "./types";

const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

/** Modulo 10 recursive check used by Swiss QR references (QRR). */
export function isValidQrReference(input: string): boolean {
  const digits = input.replace(/\s+/g, "");
  if (!/^\d{27}$/.test(digits)) return false;
  let carry = 0;
  for (let i = 0; i < 26; i++) {
    carry = MOD10_TABLE[(carry + Number(digits[i])) % 10]!;
  }
  return (10 - carry) % 10 === Number(digits[26]);
}

/** ISO 11649 creditor reference ("RF" + 2 check digits + up to 21 alphanumerics). */
export function isValidCreditorReference(input: string): boolean {
  const compact = input.replace(/\s+/g, "").toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    remainder = Number(`${remainder}${code}`) % 97;
  }
  return remainder === 1;
}

export interface DetectedReference {
  reference: string;
  referenceType: ReferenceType | null;
}

/**
 * Classifies a payment reference. A valid QRR or SCOR reference is returned
 * without whitespace (and SCOR upper-cased); anything else is kept as given
 * (trimmed) with a null type.
 */
export function detectReference(value: string): DetectedReference {
  const trimmed = value.trim();
  if (isValidQrReference(trimmed)) {
    return { reference: trimmed.replace(/\s+/g, ""), referenceType: "QRR" };
  }
  if (isValidCreditorReference(trimmed)) {
    return {
      reference: trimmed.replace(/\s+/g, "").toUpperCase(),
      referenceType: "SCOR",
    };
  }
  return { reference: trimmed, referenceType: null };
}
