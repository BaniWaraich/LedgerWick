/**
 * What to do about a candidate set.
 *
 * spec: docs/workflows/manual-invoice-upload.md §10 · docs/architecture.md §10 Stage 3
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * ## A conjunction, not a score
 *
 * Every term below is required. That is the whole design, and the reason is how the two
 * shapes fail.
 *
 * Under a weighted score, a missing signal is a slightly lower number, and a slightly
 * lower number can still clear a bar. So an invoice with no vendor match and a very close
 * amount adds up to "confident" and links itself. Under a conjunction, a missing signal is
 * a stop, and the failure mode is asking a person who did not need to be asked.
 *
 * `docs/testing-strategy.md` says which of those is expensive: "A false positive costs
 * more than asking the user." A wrong link looks finished -- it reaches the Excel export,
 * and the only person who can catch it is the accountant who was told the reconciliation
 * was complete.
 *
 * ## What the model is allowed to do
 *
 * Agree, or stop it. `AUTO_MATCH` requires the model to have named the same candidate the
 * evidence already supports; anything else -- `UNSURE`, `DIFFERENT`, a different
 * candidate, no answer at all -- is a downgrade to review. The model can never promote a
 * candidate the evidence does not already carry, which is `0003`'s line held in the one
 * place a model's opinion could otherwise become authority.
 *
 * ## Why the failed term is returned
 *
 * `blockedBy` is not for the user. It is for the bench and the acceptance log: when an
 * invoice that should have matched did not, the first question is which term stopped it,
 * and reconstructing that from the evidence afterwards is guesswork.
 */

import type { Evidence } from "./evidence";
import {
  AUTO_MATCH_AMOUNT_TOLERANCE_MINOR,
  AUTO_MATCH_DATE_DAYS,
  AUTO_MATCH_MAX_SURVIVING_CANDIDATES,
} from "./thresholds";

/** What the model said about a candidate set. */
export interface Adjudication {
  /** The rank of the candidate the model picked, or null for none of them. */
  readonly candidateRank: number | null;
  readonly verdict: "SAME" | "UNSURE" | "DIFFERENT";
  readonly reason: string;
}

export type Outcome =
  | { readonly kind: "AUTO_MATCH"; readonly rank: number }
  | { readonly kind: "NEEDS_REVIEW"; readonly blockedBy: string }
  | { readonly kind: "NO_MATCH" };

/** One term of the auto-match conjunction, and the name it reports when it stops. */
interface Term {
  readonly name: string;
  readonly holds: (input: DecisionInput) => boolean;
}

export interface DecisionInput {
  readonly candidates: readonly { readonly rank: number; readonly evidence: Evidence[] }[];
  readonly adjudication: Adjudication | null;
  /** The invoice is flagged as possibly one already on file. */
  readonly suspectedDuplicate: boolean;
  /** The bounded read hit its cap, so the shortlist is not exhaustive. */
  readonly truncated: boolean;
}

function evidenceOf(input: DecisionInput) {
  return input.candidates[0]?.evidence ?? [];
}

function find<K extends Evidence["kind"]>(evidence: readonly Evidence[], kind: K) {
  return evidence.find((e) => e.kind === kind) as Extract<Evidence, { kind: K }> | undefined;
}

/**
 * The terms, in the order they are reported.
 *
 * Declared as data rather than as a chain of `if`s so that the test can enumerate them:
 * `decide.test.ts` removes each one in turn and asserts the outcome downgrades, which is
 * a test that keeps working when a term is added.
 */
const TERMS: Term[] = [
  {
    name: "one surviving candidate",
    holds: (input) =>
      input.candidates.length > 0 && input.candidates.length <= AUTO_MATCH_MAX_SURVIVING_CANDIDATES,
  },
  {
    name: "the shortlist is exhaustive",
    // A capped read means there may be a better match the system never saw. Acting on the
    // best of an admittedly partial list is the shape of a confident wrong answer.
    holds: (input) => !input.truncated,
  },
  {
    name: "not a suspected duplicate",
    // §13: a suspected duplicate is a different question -- "are these the same invoice"
    // -- and it is put to the user before anything is linked.
    holds: (input) => !input.suspectedDuplicate,
  },
  {
    name: "the same currency",
    holds: (input) => find(evidenceOf(input), "CURRENCY")?.agreement === "SAME",
  },
  {
    name: "the amount matches",
    holds: (input) => {
      const amount = find(evidenceOf(input), "AMOUNT");
      if (amount === undefined || amount.deltaMinor === null) return false;
      const magnitude = amount.deltaMinor < 0n ? -amount.deltaMinor : amount.deltaMinor;
      return magnitude <= AUTO_MATCH_AMOUNT_TOLERANCE_MINOR;
    },
  },
  {
    name: "the dates are close",
    holds: (input) => {
      const date = find(evidenceOf(input), "DATE");
      if (date === undefined || date.offsetDays === null) return false;
      return Math.abs(date.offsetDays) <= AUTO_MATCH_DATE_DAYS;
    },
  },
  {
    name: "the vendor is known",
    holds: (input) => {
      const vendor = find(evidenceOf(input), "VENDOR");
      // NORMALIZED_CONTAINS is deliberately not enough on its own. It means a string
      // appeared inside another string, with no vendor record behind it, and "anthropic"
      // inside a longer description is a substring before it is an identification.
      return vendor?.agreement === "RESOLVED" || vendor?.agreement === "ALIAS";
    },
  },
  {
    name: "the model agrees",
    holds: (input) =>
      input.adjudication !== null &&
      input.adjudication.verdict === "SAME" &&
      input.adjudication.candidateRank === input.candidates[0]?.rank,
  },
];

/**
 * Decide what happens to an invoice, given everything known about it.
 *
 * Three outcomes, as `§10` names them: link it, ask, or say nothing reliable was found.
 */
export function decideOutcome(input: DecisionInput): Outcome {
  if (input.candidates.length === 0) return { kind: "NO_MATCH" };

  const failed = TERMS.find((term) => !term.holds(input));

  return failed === undefined
    ? { kind: "AUTO_MATCH", rank: input.candidates[0].rank }
    : { kind: "NEEDS_REVIEW", blockedBy: failed.name };
}

/** The names of every term an automatic link requires. For tests and the bench. */
export const AUTO_MATCH_TERMS: readonly string[] = TERMS.map((term) => term.name);
