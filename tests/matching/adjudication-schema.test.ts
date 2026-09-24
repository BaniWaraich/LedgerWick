/**
 * What the model is allowed to answer.
 *
 * spec: docs/architecture.md §10.1 · decision: docs/decisions/0011
 *
 * The schema is the enforcement, not the prose. `§10.1` says the system must not rely on a
 * model reporting a confidence; a rule saying so holds until someone is in a hurry, and a
 * schema with no numeric field cannot be violated without a visible change to a versioned
 * file. These tests are what makes that change visible.
 */

import { describe, expect, it } from "vitest";

import {
  matchAdjudicationSchema,
  adjudicateMatchPrompt,
} from "../../src/ai/prompts/adjudicate-match.v1";

describe("the shape of an answer", () => {
  it("accepts a choice", () => {
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: 0,
      verdict: "SAME",
      reason: "The description names the same company as the invoice",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts none of them", () => {
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: null,
      verdict: "DIFFERENT",
      reason: "None of these payments is to this vendor",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts uncertainty with a candidate named", () => {
    // UNSURE is the verdict the prompt asks for freely, and it still says which payment it
    // was unsure about -- that is what feature H shows the user.
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: 1,
      verdict: "UNSURE",
      reason: "The vendor matches but two payments are equally close",
    });

    expect(parsed.success).toBe(true);
  });
});

describe("answers that would have to be interpreted", () => {
  it("refuses agreement about nothing in particular", () => {
    // SAME with no candidate is agreement about which payment, exactly? Refused here
    // rather than left for decide.ts, because an answer that has to be interpreted will
    // be interpreted differently somewhere else.
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: null,
      verdict: "SAME",
      reason: "It is the same",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses naming a payment while saying none of them is it", () => {
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: 2,
      verdict: "DIFFERENT",
      reason: "Not this one",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a verdict it was not offered", () => {
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: 0,
      verdict: "PROBABLY",
      reason: "Close enough",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses an answer with no reason", () => {
    // invoice-match-review.md §5 shows the user the reason. An empty one leaves the
    // screen with a decision and nothing to justify it.
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: 0,
      verdict: "SAME",
      reason: "",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a candidate that is not a position in the list", () => {
    const parsed = matchAdjudicationSchema.safeParse({
      candidate: -1,
      verdict: "SAME",
      reason: "The first one",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("what the schema refuses to carry at all", () => {
  it("has no field for a confidence, and drops one offered", () => {
    // architecture.md §10.1: "The system should not rely solely on an LLM saying
    // confidence = 95%." There is nowhere to put it, so nothing downstream can read one.
    const parsed = matchAdjudicationSchema.parse({
      candidate: 0,
      verdict: "SAME",
      reason: "Same vendor and amount",
      confidence: 0.95,
    });

    expect(parsed).not.toHaveProperty("confidence");
    expect(Object.keys(parsed).sort()).toEqual(["candidate", "reason", "verdict"]);
  });
});

describe("the prompt itself", () => {
  it("is a versioned file rather than an inline string", () => {
    // docs/definition-of-done.md, the LLM section.
    expect(adjudicateMatchPrompt.id).toBe("adjudicate-match");
    expect(adjudicateMatchPrompt.version).toBe(1);
  });

  it("tells the model it is reading rather than searching", () => {
    // §8 forbids asking a model to search the statement. The shortlist is already
    // narrowed, and the prompt has to say so or the model will behave as though it is not.
    expect(adjudicateMatchPrompt.system).toContain("already narrowed");
  });
});
