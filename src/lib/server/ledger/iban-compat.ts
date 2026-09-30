/**
 * Minimal IBAN helpers used by the ledger until the shared `$lib/iban` module
 * is available; swap the imports and delete this file then.
 */
export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Shows only country/check digits and the last four characters. */
export function maskIban(input: string): string {
  const iban = normalizeIban(input);
  if (iban.length <= 8) return iban;
  return `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`;
}
