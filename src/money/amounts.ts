/**
 * Reading an amount off a bank statement.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * ADR 0003 puts every number that reaches the database on this path: a model says which
 * column holds the debits, and then this function reads each one. It is therefore the
 * single place a misread digit can enter the system on the deterministic paths, and it is
 * written to return null rather than to try harder.
 *
 * Three things it deliberately does not do.
 *
 * **It never touches a float.** `parseFloat("1234.56") * 100` is 123455.99999999999 often
 * enough to matter, and the balance equation in Step 5 adds thousands of these together
 * and compares for equality. The integer and fractional halves are assembled as text and
 * handed to `BigInt` once.
 *
 * **It does not guess the decimal separator.** `1.234` is one thousand two hundred and
 * thirty-four in Mumbai and one and a bit in Frankfurt, and no amount of staring at a
 * single cell settles it. The separator is a property of the *file*, so it is a structural
 * claim the column mapping carries — the same shape of question as which column holds the
 * date, and answered once per statement rather than guessed once per row.
 *
 * **It does not decide direction.** A cell can carry two independent signals — a sign or
 * parentheses, and a printed `Dr`/`Cr` marker — and they can disagree with each other and
 * with the column the cell sits in. Reporting both and letting the walker reconcile them
 * against the mapping keeps that decision in one place instead of three.
 */

import type { Currency } from "./currencies";

/** An explicit sign printed in the cell. */
export type AmountSign = "NEGATIVE" | "POSITIVE";

/** A `Dr`/`Cr` marker printed inside the amount cell itself. */
export type AmountMarker = "DEBIT" | "CREDIT";

export interface Amount {
  /** The magnitude, in minor units. Never negative — direction is reported separately. */
  readonly minorUnits: bigint;
  /** A leading minus, a unicode minus, or a parenthesised amount. Null if unsigned. */
  readonly sign: AmountSign | null;
  /** `1,200.00 Dr`. Null when the cell carries no marker. */
  readonly marker: AmountMarker | null;
}

/** Which character separates rupees from paise in this file. From the column mapping. */
export type DecimalSeparator = "." | ",";

/**
 * The minus signs a statement actually uses.
 *
 * Not only ASCII: exported PDFs routinely carry U+2212 MINUS SIGN, and a few banks print
 * an en dash. All three mean the same thing to a reader, so they mean the same thing here.
 */
const MINUS = /^[-−–]|[-−–]$/;

/**
 * `Dr` / `Cr`, however it is punctuated, at either end of the cell.
 *
 * Two patterns rather than one alternation, because the letters have to be a word of their
 * own: without the lookaround, the `CR` at the end of a cell reading `100 MCR` would be
 * read as a credit marker and the `M` silently dropped.
 */
const TRAILING_MARKER = /(?<![A-Z])(DR|CR)\.?$/i;
const LEADING_MARKER = /^(DR|CR)\.?(?![A-Z])/i;

/**
 * A spelled-out currency, at one end of the cell: `Rs. 4,850.00`, `INR 4,850.00`, `100 MCR`.
 *
 * Anchored, and that is the whole point. This used to strip letters wherever they appeared,
 * which quietly turned an identifier into a number: an IBAN reading `IE12 BOFI 9000 1775
 * 0694 08` in a column the mapping had called "credit" came out as 1.49e18 minor units, and
 * a footer reading `PAN ... STC No ...` came out as a ₹11,95,001 credit. Both sailed through
 * as transactions and broke their statement's balance by exactly their own size.
 *
 * A currency is written beside an amount, never threaded through it. Letters left in the
 * middle mean this cell is not an amount, and the whitelist below refuses it.
 *
 * The separator is required for the same reason. `Rs. 4,850.00` and `INR 4,850.00` put a
 * stop or a space between the word and the number; an identifier does not. Without that
 * rule, the IFSC code `ICIC0000202` sitting in a column the mapping had called "credit"
 * lost its four letters and arrived as a ₹202.00 receipt -- which is exactly the amount a
 * real ICICI statement then failed to reconcile by.
 */
const LEADING_WORD = /^[A-Za-z]+(?:\.\s*|\s+)/;
const TRAILING_WORD = /\s+[A-Za-z]+\.?$/;

/**
 * What may be discarded from an amount: currency symbols and spaces of every width.
 *
 * A whitelist rather than "everything that is not a digit", which is what this was, and
 * which was wrong in a way only the scanned path would have shown. Stripping any unknown
 * character means `1,87,4??.00` loses its two question marks and parses cleanly as 1874.00
 * -- a garbled transcription turned into a confident wrong number, on the one path where
 * `docs/decisions/0003` says there is no deterministic layer to catch a misread digit.
 *
 * Anything left after this that is not a digit or a separator refuses the cell instead.
 */
const DISCARDABLE = /[\s\u00a0\u2007\u2009\u202f₹$€£¥₨﷼¢'`]/g;

/** What a cell must consist of, once the discardable characters are gone. */
const ONLY_DIGITS_AND_SEPARATORS = /^[0-9.,]+$/;

/**
 * Read one amount cell, or decline to.
 *
 * Returns null for anything that is not an amount — an empty cell, a dash standing in for
 * nil, a column header, a description that ended up here because the mapping was wrong.
 * The caller treats that as "this row is not a transaction", which is what keeps repeated
 * headers and page footers out of the statement lines.
 */
export function readAmount(
  text: string,
  currency: Currency,
  decimalSeparator: DecimalSeparator = ".",
): Amount | null {
  let rest = text.trim();
  if (rest === "") return null;

  let sign: AmountSign | null = null;
  let marker: AmountMarker | null = null;

  // The marker comes off first, because it sits outside the brackets: `(1,200.00) DR` does
  // not end in `)`, so looking for the accountants' negative before this would miss it and
  // report a debit as unsigned.
  const printed = TRAILING_MARKER.exec(rest) ?? LEADING_MARKER.exec(rest);
  if (printed) {
    marker = printed[1].toUpperCase() === "DR" ? "DEBIT" : "CREDIT";
    rest = rest.replace(TRAILING_MARKER, "").replace(LEADING_MARKER, "").trim();
  }

  // Accountants' negative. Checked before the sign, because `(1,200.00)` carries no minus
  // and stripping the brackets first would lose the only thing that made it negative.
  if (rest.startsWith("(") && rest.endsWith(")")) {
    sign = "NEGATIVE";
    rest = rest.slice(1, -1).trim();
  }

  if (MINUS.test(rest)) {
    // A trailing minus counts: some banks print `1,200.00-` for a debit.
    sign ??= "NEGATIVE";
    rest = rest.replace(MINUS, "").trim();
  } else if (rest.startsWith("+")) {
    sign ??= "POSITIVE";
    rest = rest.slice(1).trim();
  }

  // Currency symbols, ISO codes, and the assorted spaces a PDF exporter leaves behind.
  // Safe to do wholesale only because the two signals worth keeping are already out.
  //
  // Words go first, and they take their own full stop with them. `Rs. 4,850.00` otherwise
  // keeps the stop after `Rs`, arrives here as `.4850.00`, and is refused for having two
  // decimal points — a rupee sign spelled out is not a malformed amount.
  const cleaned = rest
    .replace(LEADING_WORD, " ")
    .replace(TRAILING_WORD, " ")
    .replace(DISCARDABLE, "");
  if (!ONLY_DIGITS_AND_SEPARATORS.test(cleaned)) return null;

  const grouping = decimalSeparator === "." ? "," : ".";
  const ungrouped = cleaned.split(grouping).join("");

  const parts = ungrouped.split(decimalSeparator);
  // Two decimal points is not an amount we are willing to interpret.
  if (parts.length > 2) return null;

  const whole = parts[0] === "" ? "0" : parts[0];
  const fraction = parts[1] ?? "";
  if (!/^[0-9]+$/.test(whole)) return null;
  if (fraction !== "" && !/^[0-9]+$/.test(fraction)) return null;

  const scaled = scale(fraction, currency.exponent);
  if (scaled === null) return null;

  return { minorUnits: BigInt(whole + scaled), sign, marker };
}

/**
 * The fractional digits, as exactly the number of minor-unit digits this currency has.
 *
 * Short is padded. Long is refused rather than truncated, unless the surplus is zeros:
 * a yen statement may well print `1,234.00`, and that is the same amount, but `1,234.50`
 * is an amount this currency cannot hold and quietly dropping the 5 would file a number
 * nobody typed. `docs/decisions/0008` took the same line on a currency we have no exponent
 * for — refuse, and let a person answer.
 */
function scale(fraction: string, exponent: number): string | null {
  if (fraction.length <= exponent) return fraction.padEnd(exponent, "0");
  const surplus = fraction.slice(exponent);
  if (!/^0+$/.test(surplus)) return null;
  return fraction.slice(0, exponent);
}
