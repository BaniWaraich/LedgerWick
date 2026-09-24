/**
 * What an automatic link requires, and everything that stops one.
 *
 * spec: docs/workflows/manual-invoice-upload.md §10 · docs/architecture.md §10 Stage 3
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * The important test here is `every term is required`. It enumerates the conjunction and
 * breaks each term in turn, so adding a term without covering it is not possible -- the
 * loop picks it up, and a term nothing can break fails the test that says so.
 */

import { describe, expect, it } from "vitest";

import { AUTO_MATCH_TERMS, decideOutcome, type DecisionInput } from "../../src/matching/decide";
import type { Evidence } from "../../src/matching/evidence";

/** Evidence in which everything agrees. Each case below spoils exactly one thing. */
function perfectEvidence(overrides: Partial<Record<Evidence["kind"], Evidence>> = {}): Evidence[] {
  const base: Record<string, Evidence> = {
    AMOUNT: {
      kind: "AMOUNT",
      agreement: "EXACT",
      invoiceMinor: 2000n,
      transactionMinor: 2000n,
      deltaMinor: 0n,
    },
    DATE: { kind: "DATE", agreement: "SAME_DAY", offsetDays: 0 },
    VENDOR: {
      kind: "VENDOR",
      agreement: "RESOLVED",
      invoiceVendor: "Anthropic",
      transactionDescription: "ANTHROPIC",
    },
    INVOICE_NUMBER: { kind: "INVOICE_NUMBER", agreement: "IN_DESCRIPTION", invoiceNumber: "INV-1" },
    CURRENCY: {
      kind: "CURRENCY",
      agreement: "SAME",
      invoiceCurrency: "USD",
      transactionCurrency: "USD",
    },
  };

  return Object.values({ ...base, ...overrides });
}

function perfect(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    candidates: [{ rank: 0, evidence: perfectEvidence() }],
    adjudication: { candidateRank: 0, verdict: "SAME", reason: "Same vendor and amount" },
    suspectedDuplicate: false,
    truncated: false,
    ...overrides,
  };
}

/** One way to break each term, by the term's own name. */
const BREAKS: Record<string, Partial<DecisionInput>> = {
  "one surviving candidate": {
    candidates: [
      { rank: 0, evidence: perfectEvidence() },
      { rank: 1, evidence: perfectEvidence() },
    ],
  },
  "the shortlist is exhaustive": { truncated: true },
  "not a suspected duplicate": { suspectedDuplicate: true },
  "the same currency": {
    candidates: [
      {
        rank: 0,
        evidence: perfectEvidence({
          CURRENCY: {
            kind: "CURRENCY",
            agreement: "DIFFERENT",
            invoiceCurrency: "USD",
            transactionCurrency: "INR",
          },
        }),
      },
    ],
  },
  "the amount matches": {
    candidates: [
      {
        rank: 0,
        evidence: perfectEvidence({
          AMOUNT: {
            kind: "AMOUNT",
            agreement: "NEAR",
            invoiceMinor: 2000n,
            transactionMinor: 2001n,
            deltaMinor: 1n,
          },
        }),
      },
    ],
  },
  "the dates are close": {
    candidates: [
      {
        rank: 0,
        evidence: perfectEvidence({
          DATE: { kind: "DATE", agreement: "WITHIN_WINDOW", offsetDays: 9 },
        }),
      },
    ],
  },
  "the vendor is known": {
    candidates: [
      {
        rank: 0,
        evidence: perfectEvidence({
          VENDOR: {
            kind: "VENDOR",
            agreement: "NORMALIZED_CONTAINS",
            invoiceVendor: "Anthropic",
            transactionDescription: "ANTHROPIC",
          },
        }),
      },
    ],
  },
  "the model agrees": { adjudication: { candidateRank: 0, verdict: "UNSURE", reason: "Not sure" } },
};

describe("linking without asking anyone", () => {
  it("links when every term holds", () => {
    expect(decideOutcome(perfect())).toEqual({ kind: "AUTO_MATCH", rank: 0 });
  });

  it("every term is required", () => {
    // The conjunction, enumerated. A term added without a way to break it fails here,
    // which is the point: a new condition cannot arrive uncovered.
    expect(Object.keys(BREAKS).sort()).toEqual([...AUTO_MATCH_TERMS].sort());

    for (const [term, spoiled] of Object.entries(BREAKS)) {
      const outcome = decideOutcome(perfect(spoiled));

      expect(outcome.kind, `removing "${term}" should not still auto-match`).toBe("NEEDS_REVIEW");
      expect(outcome.kind === "NEEDS_REVIEW" && outcome.blockedBy).toBe(term);
    }
  });
});

describe("when the system cannot decide alone", () => {
  it("asks rather than choosing between two good candidates", () => {
    // Picking the better of two plausible transactions is a coin flip dressed as a
    // decision, and the user is the only one who knows which invoice they meant.
    const outcome = decideOutcome(perfect(BREAKS["one surviving candidate"]));

    expect(outcome.kind).toBe("NEEDS_REVIEW");
  });

  it("refuses an amount one minor unit out, however sure the model is", () => {
    // architecture.md §2.3: AI provides inference, not authority. A confident model does
    // not get to relax a term.
    const outcome = decideOutcome(
      perfect({
        ...BREAKS["the amount matches"],
        adjudication: { candidateRank: 0, verdict: "SAME", reason: "Certainly the same" },
      }),
    );

    expect(outcome.kind).toBe("NEEDS_REVIEW");
  });

  it("does not let the model pick a candidate the evidence does not support", () => {
    // The model naming a different candidate than the one the evidence carries is
    // disagreement, not a second opinion worth acting on.
    const outcome = decideOutcome(
      perfect({ adjudication: { candidateRank: 3, verdict: "SAME", reason: "That one" } }),
    );

    expect(outcome.kind === "NEEDS_REVIEW" && outcome.blockedBy).toBe("the model agrees");
  });

  it("asks when the model was never reached", () => {
    // A gateway with no credit is not a verdict. It must not read as agreement.
    const outcome = decideOutcome(perfect({ adjudication: null }));

    expect(outcome.kind === "NEEDS_REVIEW" && outcome.blockedBy).toBe("the model agrees");
  });

  it("will not act on the best of a list it knows is partial", () => {
    const outcome = decideOutcome(perfect({ truncated: true }));

    expect(outcome.kind === "NEEDS_REVIEW" && outcome.blockedBy).toBe(
      "the shortlist is exhaustive",
    );
  });
});

describe("when nothing was found at all", () => {
  it("says so rather than asking about nothing", () => {
    // §10's third outcome. NEEDS_REVIEW with no candidates would put an empty question in
    // the queue, which is worse than the honest "we could not find this one".
    expect(decideOutcome(perfect({ candidates: [] }))).toEqual({ kind: "NO_MATCH" });
  });

  it("is still no match when the model offered an opinion anyway", () => {
    const outcome = decideOutcome(
      perfect({
        candidates: [],
        adjudication: { candidateRank: 0, verdict: "SAME", reason: "Invented" },
      }),
    );

    expect(outcome).toEqual({ kind: "NO_MATCH" });
  });
});
