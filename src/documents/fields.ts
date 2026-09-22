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
 * `readDate` that parse every statement in the system. Unlike a statement, though, the model
 * *is* in the value path here: it transcribes, and this re-interprets what it transcribed.
 * Nothing above reads a value out of the document itself.
 *
 * Two checks stand in for that, and neither is as strong as the thing it replaces.
 *
 * **The parse.** A span that will not read as money at all is not an amount, and is refused
 * rather than cleaned up.
 *
 * **The anchor.** Where the document yielded text, the characters the model reported must
 * appear in it. That is the closest available substitute for reading the value off the page,
 * and it catches a figure that is not there at all, a transposition, and a grouping the model
 * normalised rather than copied. It cannot run on the visual path, which has no text.
 *
 * What neither buys is a guarantee that the model looked at the right line. `0010` says so
 * plainly, and that is what the eval in `docs/extraction-acceptance.md` is for. Keeping the
 * two apart matters: this file makes misreadings visible, and only the corpus makes
 * mislocations visible.
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
   * Spans the model reported that were thrown away, and why.
   *
   * Kept rather than counted, in the spirit of `walk.skipped`: a field that vanished and a
   * field that was never there look identical from the outside, and feature D lost a
   * quarter of a statement to exactly that blindness. Naming them means an extraction that
   * quietly dropped the total can be told apart from an invoice that prints no total.
   *
   * The reason matters as much as the span. `NOT_ON_PAGE` and `UNPARSEABLE` call for
   * opposite fixes -- one is a model inventing a figure, the other is a document we cannot
   * read -- and a single count of "dropped" would hide which of the two is happening.
   */
  readonly unparsed: readonly Dropped[];
}

/**
 * A span that did not survive, and what was wrong with it.
 *
 * Not exported: it is reachable through `InvoiceFields.unparsed`, and nothing needs the
 * name. Exporting it would only add an entry to `knip` that no caller justifies.
 */
interface Dropped {
  readonly field: string;
  readonly text: string;
  /**
   * `NOT_ON_PAGE` -- these characters are not in the text extracted from the document, so
   * the model did not read them off it.
   *
   * `UNPARSEABLE` -- the characters are on the page, and are not a value we can read.
   */
  readonly reason: "NOT_ON_PAGE" | "UNPARSEABLE";
}

/**
 * What survives when a span is reduced to the part that decides its value.
 *
 * `readAmount` discards currency symbols and spacing before it reads anything, and
 * `readDate` splits on separators and ignores the month's spelling. So the characters that
 * actually determine what gets stored are the digits and the separators between them, and
 * those are the characters worth checking against the page.
 *
 * Reducing both sides the same way is what makes the check survive the two things that are
 * not errors. A PDF's text layer splits a number across runs -- `1,20,` then `000.00` --
 * and joining them leaves a space in the middle that no reader would write. And a model
 * that writes `Rs.` where the page prints `₹` has changed nothing about the amount.
 * Requiring those to match exactly would drop correct totals, which is the failure this
 * check must not introduce.
 */
const VALUE_CHARACTERS = /[^0-9,./:-]/g;

/**
 * A separator at either end of what is left, which belongs to a word rather than a number.
 *
 * `Rs. 1,20,000.00` reduces to `.1,20,000.00` without this -- the stop is the abbreviation's,
 * not the amount's -- and that leading dot is enough to miss a page printing `₹1,20,000.00`.
 * A separator only means anything between digits.
 */
const EDGE_SEPARATORS = /^[,./:-]+|[,./:-]+$/g;

function reduceToValue(text: string): string {
  return text.replace(VALUE_CHARACTERS, "").replace(EDGE_SEPARATORS, "");
}

/**
 * Whether the model read this span off the document, or produced it some other way.
 *
 * decision: docs/decisions/0010-extraction-returns-locators.md
 *
 * The deterministic check `0010` left on the table. A statement's values never leave
 * `unpdf`'s output -- the model names a column and code reads the cell -- but an invoice has
 * no table to index into, so the model transcribes the characters and is therefore in the
 * value path. This is the closest available substitute: the characters it reported have to
 * be in the text that came out of the document.
 *
 * It catches a figure that is not on the page at all, a transposition, and a grouping the
 * model normalised rather than copied. It does **not** catch a **mislocation** -- the
 * subtotal is exactly as present on the page as the total -- and nothing here should be
 * read as claiming otherwise. That error is found by a person, against the corpus, per
 * `docs/extraction-acceptance.md`.
 *
 * A span with no digits in it anchors trivially, which is correct: there is nothing to
 * verify, and `readAmount` and `readDate` will refuse it on their own.
 */
export function anchored(span: string, sourceText: string): boolean {
  const needle = reduceToValue(span);
  if (needle === "") return true;
  return reduceToValue(sourceText).includes(needle);
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
export function invoiceFieldsFrom(
  reading: InvoiceReading,
  /**
   * The text extracted from the document, where there is any.
   *
   * Present on the text path and absent on the visual one, where a photograph or a scan
   * yields no ground truth to check against. That asymmetry is real and is left visible
   * rather than papered over: `0003` already accepts a higher error rate where a model
   * reads values with nothing deterministic beneath it, and the visual path is that case.
   */
  sourceText?: string,
): InvoiceFields {
  const currency = currencyFor(reading.currency);
  const unparsed: Dropped[] = [];

  /*
   * Anchoring happens before parsing, and on every span at once.
   *
   * A span that is not on the page is not worth parsing, and recording it as UNPARSEABLE
   * would mislabel the failure -- it may well parse perfectly, which is exactly what makes
   * an invented figure dangerous.
   */
  const offPage = new Set<string>();
  if (sourceText !== undefined) {
    for (const [field, span] of [
      ["total", reading.total],
      ["tax", reading.tax],
      ["subtotal", reading.subtotal],
      ["invoiceDate", reading.invoiceDate],
    ] as const) {
      if (span !== null && !anchored(span.text, sourceText)) {
        offPage.add(field);
        unparsed.push({ field, text: span.text, reason: "NOT_ON_PAGE" });
      }
    }
  }

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
      if (span !== null && !offPage.has(field)) {
        unparsed.push({ field, text: span.text, reason: "UNPARSEABLE" });
      }
    }
  }

  const amount = (field: "total" | "tax" | "subtotal"): bigint | null => {
    const span = reading[field];
    if (span === null || offPage.has(field)) return null;
    const value = money(span, currency, reading.decimalSeparator);
    if (value === null && currency !== null) {
      unparsed.push({ field, text: span.text, reason: "UNPARSEABLE" });
    }
    return value;
  };

  const totalMinor = amount("total");
  const taxMinor = amount("tax");
  const subtotalMinor = amount("subtotal");

  let invoiceDate: IsoDate | null = null;
  if (reading.invoiceDate !== null && !offPage.has("invoiceDate")) {
    invoiceDate = readDate(reading.invoiceDate.text, reading.dateOrder);
    if (invoiceDate === null) {
      unparsed.push({
        field: "invoiceDate",
        text: reading.invoiceDate.text,
        reason: "UNPARSEABLE",
      });
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
