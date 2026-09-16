/**
 * The currencies this system knows how to count in.
 *
 * `docs/decisions/0004-data-access.md` stores money as integer minor units and accepted one
 * open edge in as many words: "minor-unit exponents vary by currency". Nothing recorded the
 * exponent, which was harmless only while every account was INR. It stops being harmless the
 * moment a JPY statement arrives — a yen has no minor unit, so an amount read against an
 * assumed exponent of 2 is wrong by a factor of a hundred rather than merely mislabelled.
 *
 * This table is what makes the integer representation safe outside India, and it is
 * deliberately short. It is a list of currencies someone has thought about, not an attempt
 * at ISO 4217 in full: 180 entries nobody has tested are worse than fifteen that are. A code
 * arriving from a document that is not here is a gap to fill — deliberately, with a test —
 * rather than a bug to route around. `0008` says a statement whose currency is not here asks
 * the user rather than guessing.
 */

/** A currency, and the exponent that says where its decimal point sits. */
export interface Currency {
  /** ISO 4217 alpha-3, uppercase. */
  readonly code: string;
  /**
   * The ISO minor-unit exponent: 100 paise to a rupee is 2, a yen has no minor unit at all.
   *
   * Kept as the exponent rather than as a multiplier because that is what the standard
   * publishes, and because `10n ** BigInt(exponent)` derives the multiplier exactly, with no
   * float anywhere on the path.
   */
  readonly exponent: 0 | 2 | 3;
  readonly name: string;
}

/**
 * Phase 1 is India-first but not India-only, so this covers the rupee, the currencies an
 * Indian business is most likely to hold or be billed in, and the two exponents that are not
 * 2 — JPY and the Gulf dinars — because a table where every exponent is the same teaches
 * nobody anything and hides the bug it exists to prevent.
 */
export const SUPPORTED_CURRENCIES: readonly Currency[] = [
  { code: "INR", exponent: 2, name: "Indian rupee" },
  { code: "USD", exponent: 2, name: "US dollar" },
  { code: "EUR", exponent: 2, name: "Euro" },
  { code: "GBP", exponent: 2, name: "Pound sterling" },
  { code: "AED", exponent: 2, name: "UAE dirham" },
  { code: "SGD", exponent: 2, name: "Singapore dollar" },
  { code: "AUD", exponent: 2, name: "Australian dollar" },
  { code: "CAD", exponent: 2, name: "Canadian dollar" },
  { code: "CHF", exponent: 2, name: "Swiss franc" },
  { code: "HKD", exponent: 2, name: "Hong Kong dollar" },
  { code: "SAR", exponent: 2, name: "Saudi riyal" },
  { code: "MYR", exponent: 2, name: "Malaysian ringgit" },
  { code: "LKR", exponent: 2, name: "Sri Lankan rupee" },
  { code: "JPY", exponent: 0, name: "Japanese yen" },
  { code: "KWD", exponent: 3, name: "Kuwaiti dinar" },
  { code: "BHD", exponent: 3, name: "Bahraini dinar" },
];

const BY_CODE = new Map(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));

/**
 * The currency for a code, or null if this system does not know it.
 *
 * Tolerant about case and surrounding space because the argument comes from a model reading
 * a document, and "inr " is the same answer as "INR". Tolerant about nothing else: a name,
 * a symbol, or a code we have no exponent for all return null, because the caller's next
 * move — ask the user — is the same for all three.
 */
export function currencyFor(code: string | null | undefined): Currency | null {
  if (!code) return null;
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

/** Whether this system can count money in the given currency. */
export function isKnownCurrency(code: string | null | undefined): boolean {
  return currencyFor(code) !== null;
}
