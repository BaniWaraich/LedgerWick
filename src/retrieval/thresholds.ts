/**
 * Every number retrieval searches and fetches with.
 *
 * spec: docs/workflows/retrieve-invoices.md §7 · decision:
 * docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * ## None of these decides whether anything is linked
 *
 * That is the point of keeping them apart from `src/matching/thresholds.ts`. Retrieval
 * decides which messages are worth downloading. Whether a downloaded document is linked is
 * decided by matching's conjunction and then by the settle step (`0016`), and neither reads
 * a number from this file. So a value here can only cost a download, a model call, or a
 * missed document. It can never cause a wrong link.
 *
 * One is taken from the specification. The rest are safety valves: they bound work inside a
 * function with a wall-clock limit, and when one bites, the fact is recorded rather than
 * hidden. None has been measured. `docs/retrieval-acceptance.md` is where they would be.
 *
 * No other file in `src/retrieval/` may hold a literal window, cap or size.
 */

/**
 * Days either side of the transaction date that a search covers.
 *
 * From the specification, not a guess: `retrieve-invoices.md §7` sets "7 days before
 * through 7 days after the transaction date", and says it "may be adjusted later based on
 * real-world usage".
 */
export const SEARCH_WINDOW_DAYS = 7;

/**
 * The most message ids one search pass takes from one mailbox.
 *
 * A safety valve. A two-week window, filtered to messages with a PDF attachment and a
 * vendor's name or an invoice word, should return a handful. When a pass returns more, its
 * Mailbox Search records `truncated`, and a truncated search cannot support an automatic
 * link (`0016`) -- the right document may be in the part we did not read.
 */
export const RESULTS_PER_PASS = 25;

/**
 * The most messages downloaded for one requirement, across every mailbox.
 *
 * A safety valve, and a cost bound: each download that turns out to be a PDF costs a
 * model call in document understanding. Five covers a genuinely ambiguous month -- a
 * vendor billing weekly, a re-sent invoice, the same mail in two mailboxes -- without
 * letting a noisy vendor turn one payment into a batch job.
 *
 * When more messages qualify than this, the shortlist is not exhaustive, and the settle
 * step treats it as it treats a truncated search.
 */
export const MAX_MESSAGES_FETCHED = 5;

/**
 * The largest attachment downloaded, in bytes.
 *
 * A safety valve against a scanned 200-page contract sharing a subject line with an
 * invoice. An invoice PDF is kilobytes; ten megabytes is far past any we would read, and
 * well inside what a background function can hold in memory. A larger file is skipped, not
 * failed: the user can still upload it by hand.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
