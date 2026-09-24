/**
 * Every number matching decides with.
 *
 * spec: docs/architecture.md §21.3, §21.4 · decision:
 * docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * ## None of these has been measured
 *
 * `architecture.md §21.4` says thresholds "should be selected based on measured
 * performance" and must not be arbitrarily chosen. They have not been, and they cannot be
 * yet: the AI Gateway has no credit (`BAN-149`) and `fixtures/invoices/` is empty
 * (`BAN-150`). So these are placeholders with a stated bias, not findings, and nothing
 * should cite them as evidence of anything.
 *
 * `docs/matching-acceptance.md` is where they stop being guesses.
 *
 * ## The bias, and why it is this direction
 *
 * `docs/testing-strategy.md`: "A false positive costs more than asking the user." An
 * invoice attached to the wrong transaction is worse than one attached to nothing, and it
 * is worse in a particular way -- it looks finished. An unmatched invoice sits in a queue
 * asking to be dealt with; a wrongly matched one is silent, it reaches the Excel export,
 * and the only person who can catch it is the accountant who was told the reconciliation
 * was complete.
 *
 * So every number here is set so that the system asks. `AUTO_MATCH_AMOUNT_TOLERANCE_MINOR`
 * is zero, the auto-match date window is a fraction of the window candidates are drawn
 * from, and one candidate is the most that can ever be linked without a person. Loosening
 * any of them is a decision that needs evidence behind it, which is the point of keeping
 * them in one file where loosening is visible in a diff.
 *
 * ## Why they are all here
 *
 * No other file in `src/matching/` may contain a literal window, tolerance or cap. A
 * constant inlined at its use site is a constant nobody can find when the measurement
 * finally arrives, and the measurement is the entire plan for these.
 */

/**
 * How many days before the invoice date a payment may have landed.
 *
 * Small, and deliberately smaller than the other side. A business pays on or after an
 * invoice is issued; a payment days *before* is usually a different transaction that
 * happens to look similar. Not zero, because an invoice dated at the end of a billing
 * period is often issued after the card was charged.
 *
 * To move this: count, in `docs/matching-acceptance.md`, how many real matches were missed
 * because the payment preceded the invoice date.
 */
export const CANDIDATE_DAYS_BEFORE = 3;

/**
 * How many days after the invoice date a payment may have landed.
 *
 * `manual-invoice-upload.md §8`: "an invoice dated one day may legitimately correspond to
 * a bank transaction occurring several days later due to payment or settlement timing."
 * Ten covers a net-7 term plus a weekend. Thirty would cover net-30 invoices and is a
 * plausible next value; it is not the starting one because a wider window means more
 * candidates, and more candidates is more chances to be confidently wrong.
 *
 * To move this: count how many real matches fell outside it.
 */
export const CANDIDATE_DAYS_AFTER = 10;

/**
 * The most transactions one bounded read will return.
 *
 * A safety valve, not a tuning knob. For one small business over a thirteen-day window
 * this should be tens of rows; the cap exists so that a workspace with an unusual volume
 * degrades into "we could not narrow this down" rather than into an unbounded read inside
 * a function with a wall-clock limit. When it bites, the candidate set records
 * `truncated`, so the user is never told a shortlist was exhaustive when it was not.
 */
export const CANDIDATE_FETCH_CAP = 200;

/**
 * How many candidates the model is ever shown.
 *
 * `architecture.md §10` Stage 2 exists to evaluate "the remaining candidates", and the
 * whole point of Stage 1 is that the set is small. Five is enough for a genuine ambiguity
 * -- a vendor billed weekly, a repeated subscription charge -- and small enough that the
 * prompt stays a comparison rather than a search.
 */
export const CANDIDATES_SHOWN_TO_MODEL = 5;

/**
 * How far apart an invoice and a transaction may be dated and still link automatically.
 *
 * Inside `CANDIDATE_DAYS_BEFORE`/`AFTER` by construction, and much tighter. A candidate
 * nine days out is worth showing a person; it is not worth acting on alone.
 */
export const AUTO_MATCH_DATE_DAYS = 3;

/**
 * How far apart the amounts may be and still link automatically. Zero.
 *
 * `domain-model.md` Rule 7 is explicit that amounts may legitimately differ -- tax, fees,
 * rounding, currency conversion -- and this does not dispute it. It says that a difference
 * the system cannot account for is a question for the user rather than something to absorb
 * silently. An automatic link is the one outcome nobody reviews, so it is the one that
 * gets the strictest test available.
 *
 * To move this: measure how often a near-miss was a true match, and what the false
 * positives cost at the same tolerance. `§21.3` asks precision, recall and false-positive
 * rate specifically.
 */
export const AUTO_MATCH_AMOUNT_TOLERANCE_MINOR = 0n;

/**
 * How many candidates may survive and still allow an automatic link. One.
 *
 * Two plausible candidates is precisely the situation `NEEDS_REVIEW` exists for. Picking
 * the better-scoring of two is a coin flip dressed as a decision, and the user is the only
 * one who knows which invoice they meant.
 */
export const AUTO_MATCH_MAX_SURVIVING_CANDIDATES = 1;

/**
 * How many invoice fields must agree before two invoices are put to the model as possibly
 * the same document.
 *
 * The fields are vendor, total, date and invoice number. All four agreeing is settled
 * deterministically and never reaches the model (`duplicates.ts`, tier 1). Fewer than this
 * is two different invoices from a vendor the business uses regularly, which is the normal
 * case and must not become a question.
 *
 * This is a second unmeasured number in a feature already full of them, and its errors are
 * a different harm from matching's: a missed duplicate is a silent second invoice, not a
 * wrong link. `docs/matching-acceptance.md` counts it in its own column for that reason --
 * averaging the two would hide both.
 */
export const DUPLICATE_MIN_AGREEING_FIELDS = 2;

/**
 * How far apart two invoices may be dated and still count as agreeing on date.
 *
 * Not zero: the same invoice re-issued or re-sent can carry a slightly different date, and
 * a scan read a day out is a reading error rather than a different document.
 */
export const DUPLICATE_DATE_DAYS = 2;
