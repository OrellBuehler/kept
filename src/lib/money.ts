/**
 * Amounts are integers in minor units (e.g. cents). Never use floats for money.
 */
export type Minor = number & { readonly __brand: "Minor" };

export function minor(value: number): Minor {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `Amount must be an integer in minor units, got ${value}`,
    );
  }
  return value as Minor;
}

/**
 * Parses a decimal string such as "1'234.50", "1 234,50" or "-12.3" into minor units.
 */
export function parseAmount(input: string, decimals = 2): Minor {
  const cleaned = input.trim().replace(/[\s'’]/g, "");
  const match = /^([+-])?(\d+)(?:[.,](\d+))?$/.exec(cleaned);
  if (!match) {
    throw new SyntaxError(`Not a valid amount: "${input}"`);
  }
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new RangeError(`Too many decimal places in "${input}"`);
  }
  const value =
    Number(whole) * 10 ** decimals +
    Number(fraction.padEnd(decimals, "0") || "0");
  return minor(sign === "-" ? -value : value);
}

const exponents = new Map<string, number>();

/** Number of minor-unit digits of an ISO 4217 currency (CHF 2, JPY 0, KWD 3). */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  let exp = exponents.get(code);
  if (exp === undefined) {
    exp = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
    }).resolvedOptions().maximumFractionDigits!;
    exponents.set(code, exp);
  }
  return exp;
}

export function formatAmount(
  value: Minor,
  currency: string,
  locale = "en",
): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(value / 10 ** exp);
}
