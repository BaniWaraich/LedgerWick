/**
 * Turning what the model read off a document into values the database can hold.
 *
 * decision: docs/decisions/0010-extraction-returns-locators.md
 *
 * This file is the deterministic layer `0003` says a model reading values ought to have,
 * built for a document that cannot supply one of its own. A statement has the balance
 * equation: read every row wrong and the arithmetic stops working. An invoice has nothing —
 * one page, one total, no second figure to check it against — so the only thing that can be
 * verified is not the value but the *reading*.
 *
 * So the model reports the characters, and this parses them, using the same `readAmount` and
 * `readDate` that parse every statement in the system. The check that buys is narrow and
 * real: a model that hands back "1,20,000.00" has reported what it saw, and a model that
 * hands back a span that will not parse as money at all has reported something that is not
 * an amount. Both are caught here, deterministically, before anything is persisted.
 *
 * What it does not buy is a guarantee that the model looked at the right line on the page.
 * `0010` says so plainly, and that is what the eval in `docs/extraction-acceptance.md` is
 * for. Keeping the two apart matters: this file makes misreadings visible, and the corpus is
 * what makes mislocations visible.
 *
 * The counterpart of `src/statements/scanned.ts`, and deliberately the same shape.
 */

import type { InvoiceReading } from "../ai/prompts/read-invoice.v1";
import { readAmount } from "../money/amounts";
import { currencyFor, type Currency } from "../money/currencies";
import type { IsoDate } from "../statements/dates";
import { readDate } from "../statements/dates";

/** The names an invoice gave for its issuer, before any of them has been looked up. */
export interface VendorNames {
  readonly legalName: string | null;
  readonly tradeName: string | null;
  readonly aliases: readonly string[];
}

/** One document's invoice information, parsed. */
export interface InvoiceFields {
  readonly vendor: VendorNames | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: IsoDate | null;
  readonly currency: Currency | null;
  readonly totalMinor: bigint | null;
  readonly taxMinor: bigint | null;
  readonly subtotalMinor: bigint | null;
  /**
   * Spans the model reported that did not parse.
   *
   * Kept rather than counted, in the spirit of `walk.skipped`: a field that vanished and a
   * field that was never there look identical from the outside, and feature D lost a
   * quarter of a statement to exactly that blindness. Naming them means an extraction that
   * quietly dropped the total can be told apart from an invoice that prints no total.
   */
  readonly unparsed: readonly { readonly field: string; readonly text: string }[];
}

/**
 * Parse one printed span as money, or decline to.
 *
 * Declining is the point. `readAmount` refuses anything that is not an amount once currency
 * symbols and spacing are gone — a garbled transcription, a line of prose, an identifier —
 * and refusing here is what stops `1,87,4??.00` becoming a confident ₹1,874.00.
 */
function money(
  span: { text: string } | null,
  currency: Currency | null,
  separator: InvoiceReading["decimalSeparator"],
): bigint | null {
  if (span === null || currency === null) return null;
  return readAmount(span.text, currency, separator)?.minorUnits ?? null;
}

/**
 * Read a document's fields from what the model reported.
 *
 * Pure, and total: every field either parses or comes back null with its span recorded.
 * Nothing here throws, because every caller is a background workflow for which "this
 * document did not yield a total" is an outcome to record rather than an error to retry.
 */
export function invoiceFieldsFrom(reading: InvoiceReading): InvoiceFields {
  const currency = currencyFor(reading.currency);
  const unparsed: { field: string; text: string }[] = [];

  /*
   * A currency the table does not know is not a currency we can count in.
   *
   * `src/money/currencies.ts` holds an exponent per currency, and an amount stored against
   * the wrong one is wrong by a factor of a hundred rather than merely mislabelled. So an
   * unknown code drops the amounts rather than guessing at two decimal places -- and
   * records them, so the document reads as "we could not use this" rather than as an
   * invoice that happened to print no figures.
   */
  if (reading.currency !== null && currency === null) {
    for (const [field, span] of [
      ["total", reading.total],
      ["tax", reading.tax],
      ["subtotal", reading.subtotal],
    ] as const) {
      if (span !== null) unparsed.push({ field, text: span.text });
    }
  }

  const amount = (field: "total" | "tax" | "subtotal"): bigint | null => {
    const span = reading[field];
    if (span === null) return null;
    const value = money(span, currency, reading.decimalSeparator);
    if (value === null && currency !== null) unparsed.push({ field, text: span.text });
    return value;
  };

  const totalMinor = amount("total");
  const taxMinor = amount("tax");
  const subtotalMinor = amount("subtotal");

  let invoiceDate: IsoDate | null = null;
  if (reading.invoiceDate !== null) {
    invoiceDate = readDate(reading.invoiceDate.text, reading.dateOrder);
    if (invoiceDate === null) {
      unparsed.push({ field: "invoiceDate", text: reading.invoiceDate.text });
    }
  }

  return {
    vendor: reading.vendor,
    invoiceNumber: reading.invoiceNumber,
    invoiceDate,
    currency,
    totalMinor,
    taxMinor,
    subtotalMinor,
    unparsed,
  };
}

/**
 * Whether enough was obtained for this document to be worth anything downstream.
 *
 * spec: `manual-invoice-upload.md §6` — "The minimum useful information for automatic
 * reconciliation is generally: Vendor identity, Total amount, Invoice date or another
 * meaningful date."
 *
 * Exactly those three, and deliberately not more. `§6` is explicit that an invoice number
 * "should not be treated as universally mandatory" and that additional fields "should not
 * unnecessarily prevent a valid invoice from being processed" — many Indian receipts carry
 * no number and no tax breakdown, and refusing them would throw away real expenses.
 *
 * This is what decides `EXTRACTED` against `UNREADABLE`: what was obtained, not what was
 * believed. Belief is `classification`, and it is a separate column for that reason.
 */
export function hasMinimumFields(fields: InvoiceFields): boolean {
  const namesSomeone =
    fields.vendor !== null &&
    (fields.vendor.legalName !== null || fields.vendor.tradeName !== null);

  return namesSomeone && fields.totalMinor !== null && fields.invoiceDate !== null;
}
