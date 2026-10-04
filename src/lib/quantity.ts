import { currencyExponent, minor, type Minor } from "./money";

/**
 * Quantities, unit prices and FX rates: integers scaled by 1e8, so
 * 1.5 is 150_000_000. Safe up to about 90 million units. Never use floats.
 */
export type Fixed8 = number & { readonly __brand: "Fixed8" };

export const FIXED_DECIMALS = 8;
const SCALE = 100_000_000n;

export function fixed(value: number): Fixed8 {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `Value must be an integer scaled by 1e8, got ${value}`,
    );
  }
  return value as Fixed8;
}

/**
 * Parses a decimal string such as "12.5", "1'234,5" or "0.00000001" with at
 * most 8 decimals. Accepts the same separators as `parseAmount`.
 */
export function parseFixed(input: string): Fixed8 {
  const cleaned = input.trim().replace(/[\s'’]/g, "");
  const match = /^([+-])?(\d+)(?:[.,](\d+))?$/.exec(cleaned);
  if (!match) {
    throw new SyntaxError(`Not a valid number: "${input}"`);
  }
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > FIXED_DECIMALS) {
    throw new RangeError(`Too many decimal places in "${input}"`);
  }
  const scaled =
    BigInt(whole!) * SCALE + BigInt(fraction.padEnd(FIXED_DECIMALS, "0"));
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Number is too large: "${input}"`);
  }
  const value = Number(scaled);
  return fixed(sign === "-" && value !== 0 ? -value : value);
}

/**
 * The only entry point for floats, for numbers in a provider's JSON.
 * Rounds to 8 decimals via the decimal string.
 */
export function fixedFromProviderNumber(n: number): Fixed8 {
  if (!Number.isFinite(n)) {
    throw new RangeError(`Provider number is not finite: ${n}`);
  }
  return parseFixed(n.toFixed(FIXED_DECIMALS));
}

function split(value: Fixed8): {
  negative: boolean;
  whole: bigint;
  fraction: string;
} {
  const abs = BigInt(Math.abs(value));
  return {
    negative: value < 0,
    whole: abs / SCALE,
    fraction: String(abs % SCALE).padStart(FIXED_DECIMALS, "0"),
  };
}

/** Plain decimal for form fields, e.g. 150_000_000 -> "1.5" (round-trips with parseFixed). */
export function fixedToInput(value: Fixed8): string {
  const { negative, whole, fraction } = split(value);
  const trimmed = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

/** Display text with grouping, at least `minFraction` and at most 8 decimals. */
export function formatFixed(
  value: Fixed8,
  locale = "en",
  minFraction = 0,
): string {
  const { negative, whole, fraction } = split(value);
  const formatter = new Intl.NumberFormat(locale);
  const decimal =
    formatter.formatToParts(1.1).find((p) => p.type === "decimal")?.value ??
    ".";
  const trimmed = fraction.replace(/0+$/, "").padEnd(minFraction, "0");
  return `${negative ? "-" : ""}${formatter.format(whole)}${trimmed ? `${decimal}${trimmed}` : ""}`;
}

/** 1 / rate, rounded half away from zero. Throws for a zero rate. */
export function invertFixed(rate: Fixed8): Fixed8 {
  if (rate === 0) throw new RangeError("Cannot invert a zero rate");
  const den = BigInt(Math.abs(rate));
  const rounded = Number((SCALE * SCALE + den / 2n) / den);
  return fixed(rate < 0 ? -rounded : rounded);
}

function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * `quantity * price * fx` in `currency`'s minor units, in integer arithmetic.
 * Rounds half away from zero. With `invertFx` the rate is divided instead of
 * multiplied (value is in the quote currency of an inverse pair), without
 * first rounding 1 / rate to 8 decimals. BigInt keeps the products exact.
 */
export function valueOf(
  quantity: Fixed8,
  price: Fixed8,
  fx: Fixed8,
  currency: string,
  invertFx = false,
): Minor {
  const scale = 10n ** BigInt(currencyExponent(currency));
  const q = BigInt(Math.abs(quantity));
  const p = BigInt(Math.abs(price));
  const f = BigInt(Math.abs(fx));
  let rounded: bigint;
  if (invertFx) {
    if (f === 0n) throw new RangeError("Cannot divide by a zero rate");
    rounded = divRound(q * p * scale, f * SCALE);
  } else {
    rounded = divRound(q * p * f * scale, SCALE * SCALE * SCALE);
  }
  const negative = (quantity < 0 !== price < 0) !== fx < 0;
  const value = Number(rounded);
  return minor(negative && value !== 0 ? -value : value);
}

/**
 * `amount * part / whole`, rounded half away from zero, e.g. the cost basis
 * that remains after selling `part` of `whole` units.
 */
export function proportionOf(
  amount: Minor,
  part: Fixed8,
  whole: Fixed8,
): Minor {
  if (whole === 0) throw new RangeError("Whole must not be zero");
  const rounded = Number(
    divRound(
      BigInt(Math.abs(amount)) * BigInt(Math.abs(part)),
      BigInt(Math.abs(whole)),
    ),
  );
  const negative = (amount < 0 !== part < 0) !== whole < 0;
  return minor(negative && rounded !== 0 ? -rounded : rounded);
}
