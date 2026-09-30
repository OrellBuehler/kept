const IBAN_LENGTHS: Record<string, number> = {
  CH: 21,
  LI: 21,
  DE: 22,
  AT: 20,
  FR: 27,
  IT: 27,
  GB: 22,
  NL: 18,
  BE: 16,
  ES: 24,
  LU: 20,
  PT: 25,
  IE: 22,
};

export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/** ISO 13616 mod-97 check; known countries also get a length check. */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export function formatIban(input: string): string {
  return normalizeIban(input).replace(/(.{4})(?=.)/g, "$1 ");
}

/** Keeps country + check digits and the last four characters visible. */
export function maskIban(input: string): string {
  const iban = normalizeIban(input);
  if (iban.length <= 8) return formatIban(iban);
  return formatIban(
    iban.slice(0, 4) + "•".repeat(iban.length - 8) + iban.slice(-4),
  );
}

/** QR-IBANs are CH/LI IBANs whose institution id (digits 5-9) is 30000-31999. */
export function isQrIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^(CH|LI)\d{19}$/.test(iban)) return false;
  const iid = Number(iban.slice(4, 9));
  return iid >= 30000 && iid <= 31999;
}
