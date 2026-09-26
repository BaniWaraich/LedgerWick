/**
 * What to ask Gmail for, for one transaction.
 *
 * spec: docs/workflows/retrieve-invoices.md §6, §7, §8
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Pure. Given a transaction date and some names, it produces the date window and the query
 * strings for each search pass, and nothing else. Every rule `§6`–`§8` sets about searching
 * is readable here in one place, and testable without a mailbox.
 *
 * ## Two passes, always both
 *
 * - **VENDOR** looks for the names the payment is known by. It finds the invoice whose
 *   subject says nothing but "Your receipt", sent from the vendor's own domain.
 * - **KEYWORD** looks for invoice words. It finds the invoice from a sender whose name we
 *   have never seen -- a reseller, a payment processor, a forwarded copy.
 *
 * Running both, every time, keeps the search deterministic: which pass found a message is a
 * fact recorded on it, not an accident of which one ran first.
 *
 * ## What is deliberately absent
 *
 * **The amount.** `§8`: "Transaction amount should not be used as a strict Gmail search
 * requirement." Currency conversion, tax and fees all move it, and an exact-amount query
 * misses exactly the invoices that most need a person to look at them. Amount is evidence,
 * weighed later by matching.
 *
 * **Anything from the transaction description.** A bank narration is mostly rail prefixes
 * and reference numbers. `UPI/402193384/ANTHROPIC` searched as words would find every mail
 * containing a number, so only the names drawn out of it are used.
 */

import type { IsoDate } from "../statements/dates";
import { SEARCH_WINDOW_DAYS } from "./thresholds";

/** The days a search covers, and the same span as Gmail wants it. */
export interface SearchWindow {
  /** First day covered, inclusive. */
  readonly start: IsoDate;
  /** Last day covered, inclusive. */
  readonly end: IsoDate;
  /** `after:` in epoch seconds: midnight UTC at the start of `start`. */
  readonly afterEpoch: number;
  /** `before:` in epoch seconds: midnight UTC at the end of `end`, exclusive. */
  readonly beforeEpoch: number;
}

export type SearchPass = "VENDOR" | "KEYWORD";

const DAY_MS = 86_400_000;

function midnightUtc(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function isoOf(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The window around a transaction date.
 *
 * Epoch seconds rather than `after:2026/04/07`, because Gmail reads a date literal in
 * Pacific time, so the same query would cover a different span depending on a rule nobody
 * reading it could see. Seconds mean one thing everywhere.
 *
 * The boundaries are UTC midnight. A transaction date has no time zone -- it is a day on a
 * bank statement -- and the few hours an Indian business day sits away from UTC are
 * immaterial against a week either side.
 */
export function searchWindow(transactionDate: IsoDate): SearchWindow {
  const day = midnightUtc(transactionDate);
  const startMs = day - SEARCH_WINDOW_DAYS * DAY_MS;
  const endMs = day + SEARCH_WINDOW_DAYS * DAY_MS;

  return {
    start: isoOf(startMs),
    end: isoOf(endMs),
    afterEpoch: startMs / 1000,
    beforeEpoch: (endMs + DAY_MS) / 1000,
  };
}

/**
 * Only messages that carry a PDF.
 *
 * Gmail applies this filter itself, from the message's structure, without our code reading
 * a body. It is how a metadata-only search can still require an attachment:
 * `format=metadata` returns no part tree, so nothing we are shown could tell us
 * (`connect-gmail.md §5`). HTML-only receipts fall outside it, which is an OPEN DECISION in
 * `retrieve-invoices.md`, not an oversight here.
 */
const HAS_PDF = "has:attachment filename:pdf";

/** The words an invoice's own email tends to use. Case does not matter to Gmail. */
export const INVOICE_WORDS = [
  "invoice",
  "receipt",
  "bill",
  "tax invoice",
  "payment confirmation",
] as const;

/**
 * A name as a Gmail search term, or null when nothing searchable is left.
 *
 * Quoted, so a two-word name is searched as a phrase. Quotes, brackets, colons and the
 * characters Gmail treats as operators are removed rather than escaped, because Gmail has
 * no escape syntax -- a vendor called `Acme: Labs` must not become a search of the `acme`
 * field.
 */
export function searchTerm(name: string): string | null {
  const cleaned = name
    .replace(/["(){}[\]:<>*]/g, " ")
    .replace(/(^|\s)[-+~]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? `"${cleaned}"` : null;
}

function window(w: SearchWindow): string {
  return `after:${w.afterEpoch} before:${w.beforeEpoch}`;
}

/**
 * The VENDOR pass, or null when there is no name to search for.
 *
 * Each name is searched both as a phrase anywhere and, where it is one word, as a sender:
 * `from:anthropic` finds `receipts@anthropic.com` even when the display name says only
 * "Receipts".
 */
export function vendorQuery(w: SearchWindow, names: readonly string[]): string | null {
  const terms: string[] = [];

  for (const name of names) {
    const term = searchTerm(name);
    if (term === null || terms.includes(term)) continue;
    terms.push(term);

    const bare = term.slice(1, -1);
    if (/^[\p{L}\p{N}.\-]+$/u.test(bare)) terms.push(`from:${bare}`);
  }

  if (terms.length === 0) return null;
  return `${window(w)} ${HAS_PDF} (${terms.join(" OR ")})`;
}

/** The KEYWORD pass. Always exists: it needs nothing but the window. */
export function keywordQuery(w: SearchWindow): string {
  const words = INVOICE_WORDS.map((word) => (word.includes(" ") ? `"${word}"` : word));
  return `${window(w)} ${HAS_PDF} (${words.join(" OR ")})`;
}
