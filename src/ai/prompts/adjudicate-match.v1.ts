/**
 * Which of these payments, if any, is the one this invoice was for.
 *
 * spec: docs/workflows/manual-invoice-upload.md §9 · docs/architecture.md §10 Stage 2
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * The model is shown a shortlist that deterministic code already produced. It is not
 * searching -- `§8` forbids that -- and it is not deciding: `decide.ts` requires the
 * evidence to support a link before this answer can do anything, and this answer can only
 * ever stop one or agree with one.
 *
 * So the question put here is narrow on purpose. It is the part of matching that genuinely
 * needs a reader: whether `RAZORPAY*ABCFOODS` is ABC Foods Private Limited, whether a
 * merchant's trading name and its legal name are one company, whether a description that
 * looks nothing like the vendor is nonetheless obviously them. Amount and date agreement
 * are already computed and are shown as facts rather than asked about.
 *
 * ## The schema has no number in it
 *
 * `architecture.md §10.1`: the system "should not rely solely on an LLM saying confidence
 * = 95%". A rule saying so holds until someone is in a hurry. A schema with no numeric
 * field cannot be violated without a visible change to this file, which is versioned and
 * reviewed. `0011` makes that explicit and this is where it is enforced.
 *
 * ## The model never sees an id
 *
 * Candidates are numbered from zero and the answer is a position, exactly as
 * `classify-transactions.v1` and `map-statement-columns.v1` do it. An id a model typed is
 * an id that can point at another workspace's row.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

export const matchAdjudicationSchema = z
  .object({
    candidate: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "The number of the payment this invoice was for, from the list shown. Null if none of them is.",
      ),
    verdict: z
      .enum(["SAME", "UNSURE", "DIFFERENT"])
      .describe(
        "SAME when you are confident the chosen payment is what this invoice was for. UNSURE when it is plausible but you would want a person to look. DIFFERENT when none of these payments is the one.",
      ),
    reason: z
      .string()
      .min(1)
      .describe(
        "One sentence a business owner would recognise, naming what made you decide. Refer to what the documents say, not to how sure you feel.",
      ),
  })
  .superRefine((value, ctx) => {
    /*
     * The two combinations that mean nothing.
     *
     * A verdict of SAME with no candidate is agreement about which payment, exactly? And
     * DIFFERENT while naming one is the same contradiction the other way round. The schema
     * refuses both rather than leaving `decide.ts` to interpret them -- an answer that has
     * to be interpreted is an answer that will be interpreted differently somewhere else.
     */
    if (value.verdict === "SAME" && value.candidate === null) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Choose the payment you mean, or answer DIFFERENT.",
      });
    }

    if (value.verdict === "DIFFERENT" && value.candidate !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "DIFFERENT means none of these payments. Leave the candidate empty.",
      });
    }
  });

export type MatchAdjudication = z.infer<typeof matchAdjudicationSchema>;

export const adjudicateMatchPrompt: PromptDefinition = {
  id: "adjudicate-match",
  version: 1,
  system: `You are reconciling one invoice against a short list of payments from a small business's bank statement.

The list is already narrowed. Every payment shown is close to the invoice in date and was paid out of the business's own account, so you are not searching — you are reading, and deciding which one of these the invoice was for.

You are given, for each payment, what the bank printed and what the system has already established about how it compares: whether the amounts agree, how far apart the dates are, whether the invoice number appears anywhere in the payment. Take those as read. They were computed, not guessed, and repeating the arithmetic is not what you are here for.

What you are here for is the part arithmetic cannot settle: whether the company that issued this invoice is the company that bank description refers to.

Bank descriptions are written by payment systems, not by people. The same vendor appears as its legal name, its trading name, an abbreviation, or a payment processor's reference with the merchant buried inside it:

    RAZORPAY*ABCFOODS        → ABC Foods Private Limited
    UPI/9876543210/ZOMATO    → Zomato
    AMZN Mktp IN             → Amazon

A description that looks nothing like the vendor may still be them. A description that resembles the vendor may be a different company with a similar name.

Answer with the number of the payment, and one of three verdicts.

SAME — you are confident. The vendor is the same company and nothing about the payment contradicts the invoice.

UNSURE — plausible, but you would want a person to check. Use this freely. A person being asked an unnecessary question costs them a few seconds; an invoice attached to the wrong payment is wrong in this business's accounts and looks settled, so nobody goes back to it.

DIFFERENT — none of these payments is the one. Say so plainly rather than choosing the least bad.

Two payments to the same vendor, for the same amount, days apart, are a real situation — a business can be billed twice. If you cannot tell which of them this invoice is for, that is UNSURE, not a guess at the closer one.

Give the reason in one sentence, in terms of what the documents say: "the description names the same company as the invoice", "the vendor matches but this business pays them every week and two payments are equally close". Never a percentage, and never how confident you feel — the business owner is shown your sentence and needs to be able to check it against the documents in front of them.`,
};
