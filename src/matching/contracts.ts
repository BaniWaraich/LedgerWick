/**
 * The model calls matching depends on, as types.
 *
 * Separated for the reason `src/requirements/contracts.ts` and
 * `src/documents/contracts.ts` both give: `match.ts`, `decide.ts` and their tests can then
 * be imported without pulling in a provider, a key, or `server-only`. Every branch of the
 * decision is reachable from a test that injects a function returning a literal.
 *
 * Implementations live in `adjudicator.ts`.
 */

import type { Inference } from "../ai/model";
import type { MatchAdjudication } from "../ai/prompts/adjudicate-match.v1";
import type { SameInvoiceJudgement } from "../ai/prompts/same-invoice.v1";
import type { Evidence } from "./evidence";

/**
 * One candidate payment, as the model is shown it.
 *
 * Numbered, never identified — the same rule `TransactionBrief` states: "The model answers
 * by this; ids never leave the server." An id a model typed is an id that can point at
 * another workspace's row.
 *
 * The evidence travels as sentences rather than as the structure. The model is being asked
 * to read, and "Amount matches exactly" is what a reader needs; the discriminated union is
 * for code and for feature H.
 */
export interface CandidateBrief {
  /** Position in the list, from zero. This is what the answer refers to. */
  readonly index: number;
  readonly valueDate: string;
  /** Formatted for a person: ₹4,850, not 485000. */
  readonly amount: string;
  readonly description: string;
  /** What the system already established, one line each. */
  readonly evidence: readonly string[];
}

/** The invoice side, as the model is shown it. */
export interface InvoiceBrief {
  readonly vendor: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly amount: string | null;
}

/**
 * Ask which candidate, if any, this invoice was for.
 *
 * Takes a set that deterministic code has already narrowed. `manual-invoice-upload.md §9`:
 * the model "should receive the normalized invoice information and a constrained set of
 * transaction candidates rather than being responsible for unrestricted transaction
 * search."
 */
export type AdjudicateMatch = (request: {
  invoice: InvoiceBrief;
  candidates: CandidateBrief[];
}) => Promise<Inference<MatchAdjudication>>;

/** One invoice, as the model is shown it when asked whether two are the same document. */
export interface DuplicateBrief {
  readonly vendor: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly amount: string | null;
}

/**
 * Ask whether two invoices are the same underlying document.
 *
 * A separate call from adjudication rather than a second question inside it. The two
 * decide different things and fail in different directions -- a missed duplicate is a
 * silent second invoice, a wrong match is a document on the wrong payment -- and
 * `docs/matching-acceptance.md` counts them in separate columns for that reason.
 */
export type JudgeSameInvoice = (request: {
  existing: DuplicateBrief;
  incoming: DuplicateBrief;
}) => Promise<Inference<SameInvoiceJudgement>>;

/** Turn stored evidence into the lines the model is shown. */
export type RenderEvidence = (evidence: readonly Evidence[]) => string[];
