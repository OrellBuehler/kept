import { currencyExponent, type Minor } from "$lib/money";

/** Plain decimal string ("1234.50") for pre-filling an amount input; sign dropped. */
export function minorToInput(value: Minor | number, currency: string): string {
  const exp = currencyExponent(currency);
  const abs = Math.abs(value);
  if (exp === 0) return String(abs);
  const s = String(abs).padStart(exp + 1, "0");
  return `${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

/** Plain decimal string with a leading minus for negatives. */
export function minorToSignedInput(
  value: Minor | number,
  currency: string,
): string {
  return (value < 0 ? "-" : "") + minorToInput(value, currency);
}
