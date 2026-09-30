const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

export function normalizeReference(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/** QR reference: 27 digits, the last one a recursive mod-10 check digit. */
export function isValidQrr(input: string): boolean {
  const ref = normalizeReference(input);
  if (!/^\d{27}$/.test(ref)) return false;
  let carry = 0;
  for (const ch of ref.slice(0, 26))
    carry = MOD10_TABLE[(carry + Number(ch)) % 10];
  return (10 - carry) % 10 === Number(ref[26]);
}

/** Creditor reference (ISO 11649): RF + 2 check digits + up to 21 alphanumerics. */
export function isValidScor(input: string): boolean {
  const ref = normalizeReference(input);
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(ref)) return false;
  const rearranged = ref.slice(4) + ref.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Groups a QRR as `XX XXXXX XXXXX XXXXX XXXXX XXXXX` and a SCOR in blocks of four. */
export function formatReference(input: string): string {
  const ref = normalizeReference(input);
  if (/^\d{27}$/.test(ref)) {
    return `${ref.slice(0, 2)} ${ref.slice(2).replace(/(\d{5})(?=\d)/g, "$1 ")}`;
  }
  return ref.replace(/(.{4})(?=.)/g, "$1 ");
}
