/**
 * What a requirement's retrieval came to.
 *
 * spec: docs/workflows/retrieve-invoices.md §16, §17, §20 · docs/state-machines.md §2
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Pure. It reads what the searches found and says what happens next, and it never writes.
 */

import type { mailboxSearchOutcomeEnum } from "../db/schema";

export type MailboxOutcome = (typeof mailboxSearchOutcomeEnum.enumValues)[number];

export type AfterSearch = "FETCH" | "NOT_FOUND" | "BLOCKED";

/**
 * After searching, before anything is downloaded.
 *
 * - Something worth downloading: download it, and let the documents decide.
 * - Nothing, and a mailbox could not be searched: `BLOCKED`. We did not look everywhere,
 *   so "not found" would be a claim we cannot make, and `retrieve-invoices.md §17` is
 *   explicit that an authorization problem is not a "no document found".
 * - Nothing, with every mailbox searched: `NOT_FOUND`. A business outcome, not a failure
 *   (`§16`).
 *
 * A `FAILED` mailbox never reaches here: its search threw, and the workflow retries it.
 */
export function afterSearch(input: {
  readonly mailboxes: readonly MailboxOutcome[];
  readonly selected: number;
}): AfterSearch {
  if (input.selected > 0) return "FETCH";
  return input.mailboxes.some((outcome) => outcome !== "COMPLETED") ? "BLOCKED" : "NOT_FOUND";
}

/**
 * What one retrieved document came to, once understood and matched.
 *
 * Plain data, because it crosses a step boundary in the assessor: Inngest memoises each
 * document's assessment, and the settle step reads them back.
 */
export interface Assessment {
  readonly documentId: string;
  /** Where understanding left it. `GONE` when the document no longer exists here. */
  readonly state: "EXTRACTED" | "UNREADABLE" | "NOT_AN_INVOICE" | "GONE";
  readonly classification: "IS_INVOICE" | "UNCERTAIN" | "IS_NOT_INVOICE" | null;
  readonly invoiceId: string | null;
  /** The transactions matching proposed for this document's invoice, best first. */
  readonly candidateTransactionIds: readonly string[];
  /** The transaction matching's conjunction would link it to, if every term held. */
  readonly autoMatchTransactionId: string | null;
  /** The matching term that stopped an automatic link, for the bench. */
  readonly blockedBy: string | null;
}

export interface SettleInput {
  /** The payment the requirement is about. */
  readonly transactionId: string;
  readonly assessments: readonly Assessment[];
  /** Documents the user has already said are not this payment's (`invoice-match-review.md §7`). */
  readonly rejected: ReadonlySet<string>;
  readonly mailboxes: readonly { readonly outcome: MailboxOutcome; readonly truncated: boolean }[];
  /** Every message worth downloading was downloaded; none was left out by the cap. */
  readonly selectionExhaustive: boolean;
}

export type Settlement =
  | { readonly kind: "AUTO"; readonly documentId: string; readonly invoiceId: string }
  | { readonly kind: "NEEDS_REVIEW"; readonly blockedBy: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "BLOCKED" };

/**
 * Whether a document is worth putting in front of the user for this payment.
 *
 * An invoice whose own evidence named this payment among its candidates, or a document we
 * could not read -- the user can open it and see. A document read as not an invoice is
 * not offered: settled with the user on 2026-09-26, and `retrieve-invoices.md §11.1` says
 * so. Nor is anything the user already rejected.
 */
export function isPlausible(assessment: Assessment, input: SettleInput): boolean {
  if (input.rejected.has(assessment.documentId)) return false;
  if (assessment.state === "UNREADABLE") return true;
  return (
    assessment.state === "EXTRACTED" &&
    assessment.invoiceId !== null &&
    assessment.candidateTransactionIds.includes(input.transactionId)
  );
}

interface Term {
  readonly name: string;
  readonly holds: (plausible: readonly Assessment[], input: SettleInput) => boolean;
}

/**
 * The requirement-level conjunction. Every term is required.
 *
 * The same shape as `src/matching/decide.ts`, and it inherits every term of that one
 * through the second term below: matching's own conjunction must already have chosen this
 * payment. What this adds is what matching, looking from the invoice's side, cannot see.
 */
const TERMS: Term[] = [
  {
    name: "one document supports this payment",
    // Two documents that each look right for one payment are one ambiguous question.
    holds: (plausible) => plausible.length === 1,
  },
  {
    name: "matching chose this payment for it",
    holds: (plausible, input) => plausible[0]?.autoMatchTransactionId === input.transactionId,
  },
  {
    name: "it reads as an invoice",
    // UNCERTAIN is a first-class answer (`state-machines.md §3`) and never a yes.
    holds: (plausible) => plausible[0]?.classification === "IS_INVOICE",
  },
  {
    name: "every mailbox was searched",
    // An unsearched mailbox might hold a competing document.
    holds: (_plausible, input) => input.mailboxes.every((m) => m.outcome === "COMPLETED"),
  },
  {
    name: "nothing found was left unread",
    // `truncated` in matching's words: a partial shortlist is how a confident wrong answer
    // is made.
    holds: (_plausible, input) =>
      input.selectionExhaustive && input.mailboxes.every((m) => !m.truncated),
  },
];

/** The names of every term an automatic link from retrieval requires. For tests and the bench. */
export const RETRIEVAL_TERMS: readonly string[] = TERMS.map((term) => term.name);

/**
 * What a requirement comes to, given everything retrieval found for it.
 *
 * - One document, on strong evidence, with nothing left unsearched: link it.
 * - Anything plausible short of that: the user decides.
 * - Nothing plausible: `BLOCKED` if a mailbox went unsearched, `NOT_FOUND` if none did.
 */
export function decideRetrieval(input: SettleInput): Settlement {
  const plausible = input.assessments.filter((assessment) => isPlausible(assessment, input));

  if (plausible.length === 0) {
    return input.mailboxes.some((m) => m.outcome !== "COMPLETED")
      ? { kind: "BLOCKED" }
      : { kind: "NOT_FOUND" };
  }

  const failed = TERMS.find((term) => !term.holds(plausible, input));
  if (failed !== undefined) return { kind: "NEEDS_REVIEW", blockedBy: failed.name };

  const [chosen] = plausible;
  // `holds` above guarantees an invoice: matching only chooses a payment for one.
  return { kind: "AUTO", documentId: chosen.documentId, invoiceId: chosen.invoiceId as string };
}
