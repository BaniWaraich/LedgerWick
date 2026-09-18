/**
 * What the model is allowed to say about a transaction.
 *
 * spec: docs/workflows/identifying-invoices.md §5 Steps 5 and 6
 *
 * These are the combinations the prose asks for, asserted as validation rather than trusted
 * to be followed. A model that returns a decision it admits it cannot make is a model whose
 * output must not reach the database, and the definition of done requires that to be a
 * handled validation failure rather than a row nobody can explain.
 */

import { describe, expect, it } from "vitest";

import { transactionJudgementsSchema } from "../../src/ai/prompts/classify-transactions.v1";

/** A confident judgment that a payment needs a document. */
const DECIDED = {
  index: 0,
  vendorGuess: "Anthropic",
  businessContext: "Software subscription",
  needsDocument: true,
  reason: "Monthly software subscription, needed for your expense records.",
  confident: true,
  clarification: null,
};

/** An undetermined payment, which becomes a question rather than a requirement. */
const ASKED = {
  index: 1,
  vendorGuess: "XYZ Services",
  businessContext: null,
  needsDocument: false,
  reason: null,
  confident: false,
  clarification: {
    question: "We found a payment of ₹18,500 to XYZ Services. What is XYZ Services?",
    options: ["A business vendor", "A personal payment", "Something else"],
  },
};

function parse(...judgements: Record<string, unknown>[]) {
  return transactionJudgementsSchema.safeParse({ judgements });
}

describe("a decided transaction", () => {
  it("is accepted with a reason", () => {
    expect(parse(DECIDED).success).toBe(true);
  });

  it("is accepted when it needs no document and gives no reason", () => {
    expect(parse({ ...DECIDED, needsDocument: false, reason: null }).success).toBe(true);
  });

  it("is refused when it needs a document but says nothing about why", () => {
    // The reason is what the user reads. A requirement the system cannot explain is one
    // the user cannot act on -- §7 H forbids showing a score in its place.
    const result = parse({ ...DECIDED, reason: null });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["judgements", 0, "reason"]);
  });

  it("is refused when it is confident and asks a question anyway", () => {
    const result = parse({ ...DECIDED, clarification: ASKED.clarification });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["judgements", 0, "clarification"]);
  });
});

describe("an undetermined transaction", () => {
  it("is accepted as a question", () => {
    expect(parse(ASKED).success).toBe(true);
  });

  it("is refused when it admits it cannot tell and decides anyway", () => {
    // docs/domain-model.md invariant 18: an unconfirmed inference never becomes fact.
    const result = parse({ ...ASKED, needsDocument: true, reason: "Probably a vendor." });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([
      "judgements",
      0,
      "needsDocument",
    ]);
  });

  it("is refused when it cannot tell and asks nothing", () => {
    const result = parse({ ...ASKED, clarification: null });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["judgements", 0, "clarification"]);
  });

  it("is refused when its question offers only one answer", () => {
    const result = parse({
      ...ASKED,
      clarification: { question: "Is this a vendor?", options: ["Yes"] },
    });

    expect(result.success).toBe(false);
  });
});

describe("the list as a whole", () => {
  it("takes decided and undetermined transactions together", () => {
    // §6: the run continues with what it can determine. A question about one transaction
    // never holds up the rest of the batch.
    expect(parse(DECIDED, ASKED).success).toBe(true);
  });

  it("reports the position of the offending judgement, not just that one was wrong", () => {
    const result = parse(DECIDED, { ...ASKED, clarification: null });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["judgements", 1, "clarification"]);
  });

  it("refuses a judgement that answers about no transaction in particular", () => {
    expect(parse({ ...DECIDED, index: -1 }).success).toBe(false);
  });

  it("accepts an empty list, because a run with nothing new to judge is normal", () => {
    expect(transactionJudgementsSchema.safeParse({ judgements: [] }).success).toBe(true);
  });
});
