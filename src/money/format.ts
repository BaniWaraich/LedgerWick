/**
 * Showing an amount to the person who owns it.
 *
 * The inverse of `amounts.ts`, and it keeps that file's discipline: the integer is split
 * into a whole part and a fraction as text, with `bigint` throughout and no float anywhere
 * on the path. A statement with a crore in it is not a special case here, it is just a
 * longer string.
 *
 * Grouping is not decoration. An Indian business reads 1,20,000 and would have to stop and
 * count the digits in 120,000 — and this product is India-first, showing people figures they
 * are about to check against their own bank's statement. `Intl.NumberFormat` knows the rule,
 * but reaching it means going through a `number`, which is the one thing the rest of the
 * money code refuses to do. The rule itself is three lines, so it is written out.
 */

import type { Currency } from "./currencies";

/**
 * What to print in front of the amount.
 *
 * Only for the currencies `SUPPORTED_CURRENCIES` knows. Anything else shows its ISO code,
 * which is unambiguous and honest — better than a bare `$` that could be one of five
 * currencies, which is the same care `identify-statement.v2` takes over reading one.
 */
const SYMBOLS: Readonly<Record<string, string>> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/** The currencies grouped in lakhs and crores rather than in thousands. */
const INDIAN_GROUPING = new Set(["INR"]);

/** An amount in minor units, as a person reads it. */
export function formatAmount(minorUnits: bigint, currency: Currency): string {
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;

  const scale = 10n ** BigInt(currency.exponent);
  const whole = (magnitude / scale).toString();
  const fraction = (magnitude % scale).toString().padStart(currency.exponent, "0");

  const symbol = SYMBOLS[currency.code] ?? `${currency.code} `;
  const grouped = group(whole, INDIAN_GROUPING.has(currency.code));
  const decimals = currency.exponent === 0 ? "" : `.${fraction}`;

  return `${negative ? "-" : ""}${symbol}${grouped}${decimals}`;
}

/**
 * Digits, grouped.
 *
 * Western grouping is every three. Indian grouping is every three for the last group and
 * every two above it — 12,34,56,789 rather than 123,456,789 — which is why it cannot be done
 * by a single regular expression and is worth a test.
 */
function group(digits: string, indian: boolean): string {
  if (!indian) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (digits.length <= 3) return digits;

  const last = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last}`;
}
