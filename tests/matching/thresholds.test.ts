/**
 * The bias in the thresholds, asserted.
 *
 * spec: docs/architecture.md §21.4 · docs/testing-strategy.md
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * These are blunt on purpose. They do not test that the numbers are right -- nothing can,
 * until `docs/matching-acceptance.md` has entries in it. They test the one property the
 * numbers are supposed to have while they are still guesses: that they err toward asking
 * the user.
 *
 * So this file exists to make loosening a threshold a deliberate act. Widening the
 * auto-match window past the candidate window, or allowing an amount to differ, breaks a
 * test whose name says why that direction is the expensive one.
 */

import { describe, expect, it } from "vitest";

import {
  AUTO_MATCH_AMOUNT_TOLERANCE_MINOR,
  AUTO_MATCH_DATE_DAYS,
  AUTO_MATCH_MAX_SURVIVING_CANDIDATES,
  CANDIDATE_DAYS_AFTER,
  CANDIDATE_DAYS_BEFORE,
  CANDIDATE_FETCH_CAP,
  CANDIDATES_SHOWN_TO_MODEL,
  DUPLICATE_DATE_DAYS,
  DUPLICATE_MIN_AGREEING_FIELDS,
} from "../../src/matching/thresholds";

describe("a link made without a person is the strictest case", () => {
  it("never links an amount that does not match exactly", () => {
    // docs/domain-model.md Rule 7 allows amounts to differ legitimately. This does not
    // dispute that -- it says a difference the system cannot account for is a question,
    // because an automatic link is the one outcome nobody reviews.
    expect(AUTO_MATCH_AMOUNT_TOLERANCE_MINOR).toBe(0n);
  });

  it("never links when two candidates survived", () => {
    // Choosing the better of two plausible transactions is a coin flip dressed as a
    // decision. NEEDS_REVIEW is what that situation is for.
    expect(AUTO_MATCH_MAX_SURVIVING_CANDIDATES).toBe(1);
  });

  it("links over a narrower date window than it proposes over", () => {
    // A candidate nine days out is worth showing a person and is not worth acting on
    // alone. If these ever met, every candidate the date filter admitted would be
    // auto-linkable on date, and the wider window would stop being a shortlist.
    expect(AUTO_MATCH_DATE_DAYS).toBeLessThan(CANDIDATE_DAYS_AFTER);
    expect(AUTO_MATCH_DATE_DAYS).toBeLessThanOrEqual(CANDIDATE_DAYS_BEFORE);
  });
});

describe("the candidate set stays small enough to be a shortlist", () => {
  it("shows the model fewer candidates than it will fetch", () => {
    // Stage 2 evaluates what Stage 1 narrowed. If the model saw everything fetched, Stage
    // 1 would not be narrowing anything and architecture.md §10's first stage would be
    // decorative.
    expect(CANDIDATES_SHOWN_TO_MODEL).toBeLessThan(CANDIDATE_FETCH_CAP);
  });

  it("looks forward further than back", () => {
    // A business pays on or after an invoice is issued. A payment days before is usually
    // a different transaction that happens to resemble this one.
    expect(CANDIDATE_DAYS_AFTER).toBeGreaterThan(CANDIDATE_DAYS_BEFORE);
  });

  it("caps the read rather than trusting the window to be small", () => {
    // The window is an assumption about one business's volume. The cap is what happens
    // when the assumption is wrong, inside a function with a wall-clock limit.
    expect(CANDIDATE_FETCH_CAP).toBeGreaterThan(0);
    expect(Number.isFinite(CANDIDATE_FETCH_CAP)).toBe(true);
  });
});

describe("asking whether two invoices are the same document", () => {
  it("does not ask when a single field agrees", () => {
    // One agreeing field is two different invoices from a vendor the business uses
    // regularly. That is the normal case and must not become a question.
    expect(DUPLICATE_MIN_AGREEING_FIELDS).toBeGreaterThan(1);
  });

  it("allows a date to differ slightly", () => {
    // The same invoice re-issued carries a slightly different date, and a scan read a day
    // out is a reading error rather than a different document.
    expect(DUPLICATE_DATE_DAYS).toBeGreaterThan(0);
  });
});
