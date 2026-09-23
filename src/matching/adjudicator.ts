/**
 * Putting one invoice and a shortlist of payments in front of the model.
 *
 * The counterpart to `classifier.ts` and `reader.ts`, kept apart from `match.ts` for the
 * same reason: the code that decides what to do with an answer should have no dependency
 * on a provider or a key, so every branch of it is reachable from a test.
 *
 * Amounts go up formatted rather than as minor units, as `classifier.ts` does it. ₹4,850
 * is the figure on the document; `485000` is a number the model would have to decode
 * before it could compare anything, and decoding it is not the judgment being asked for.
 */

import "server-only";

import { inferStructure } from "../ai/model";
import { adjudicateMatchPrompt, matchAdjudicationSchema } from "../ai/prompts/adjudicate-match.v1";
import { currencyFor } from "../money/currencies";
import { formatAmount } from "../money/format";
import type { AdjudicateMatch, CandidateBrief, InvoiceBrief } from "./contracts";

export const adjudicateMatch: AdjudicateMatch = async ({ invoice, candidates }) =>
  inferStructure({
    prompt: adjudicateMatchPrompt,
    schema: matchAdjudicationSchema,
    content: [{ type: "text", text: render(invoice, candidates) }],
  });

/**
 * An amount, as a person would read it.
 *
 * A currency this build does not know how to format is still an amount to compare. The
 * code and the integer are unambiguous, which matters more than being pretty -- the same
 * call `classifier.ts` makes.
 */
export function formatForPrompt(minor: bigint | null, code: string | null): string | null {
  if (minor === null || code === null) return null;
  const currency = currencyFor(code);
  return currency ? formatAmount(minor, currency) : `${code} ${minor}`;
}

function render(invoice: InvoiceBrief, candidates: CandidateBrief[]): string {
  return [
    "## The invoice",
    "",
    `Vendor: ${invoice.vendor ?? "not read from the document"}`,
    `Number: ${invoice.invoiceNumber ?? "none on the document"}`,
    `Dated: ${invoice.invoiceDate ?? "not read from the document"}`,
    `Total: ${invoice.amount ?? "not read from the document"}`,
    "",
    "## The payments",
    "",
    ...candidates.map(describe),
  ].join("\n");
}

function describe(candidate: CandidateBrief): string {
  return [
    `${candidate.index}. ${candidate.description}`,
    `   ${candidate.amount} on ${candidate.valueDate}`,
    ...candidate.evidence.map((line) => `   - ${line}`),
  ].join("\n");
}
