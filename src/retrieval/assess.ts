/**
 * Judging what retrieval fetched, and settling the requirement.
 *
 * spec: docs/workflows/retrieve-invoices.md §11.1, §12, §13, §16, §17, §20
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Two functions, one per Inngest step kind. `assessDocument` runs once per document, and
 * `settleRetrieval` runs once, after every document has been assessed.
 *
 * `assessDocument` puts one document through the same pipeline every document takes:
 * `understandDocument` (feature F), then, for an invoice, `proposeMatch` (feature G).
 * Nothing about where the document came from changes how it is read or judged. The model
 * calls happen there, behind the deps the caller injects. This file imports no model, and
 * no Gmail.
 *
 * `settleRetrieval` reads everything found for one payment at once, applies
 * `decideRetrieval`, and writes the outcome. The only link it can make goes through
 * `linkInvoice`, the single funnel for resolutions.
 */

import { eq } from "drizzle-orm";

import {
  candidateEmails,
  invoiceRequirements,
  mailboxSearches,
  supportingDocuments,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { leavesAnInvoice, understandDocument, type UnderstandDeps } from "../documents/understand";
import { linkInvoice } from "../matching/link";
import { proposeMatch, type MatchDeps } from "../matching/match";
import { decideRetrieval, type Assessment, type Settlement } from "./decide";
import type { EmailEvidence } from "./evidence";
import { moveRequirement } from "./requirement-state";
import { selectForFetching } from "./select";

export interface AssessDeps {
  readonly understand: UnderstandDeps;
  readonly match: MatchDeps;
}

/**
 * Understand one retrieved document and, if it is an invoice, propose its payment.
 *
 * Idempotent by what it finds, because both halves are: a document already understood is
 * left as it is, and a proposal replaces the candidate set it recorded last time. A retry
 * after a provider timeout repeats nothing that had succeeded.
 *
 * Infrastructure failure is rethrown, for the workflow to retry. It is never recorded as a
 * verdict on the document (`state-machines.md §3`: a Supporting Document has no FAILED).
 */
export async function assessDocument(
  scope: WorkspaceScope,
  documentId: string,
  deps: AssessDeps,
): Promise<Assessment> {
  const outcome = await understandDocument(scope, documentId, deps.understand);

  const document = await scope.selectOne(
    supportingDocuments,
    eq(supportingDocuments.id, documentId),
  );

  const base = {
    documentId,
    state: outcome.state ?? ("GONE" as const),
    classification: document?.classification ?? null,
    invoiceId: null,
    candidateTransactionIds: [],
    autoMatchTransactionId: null,
    blockedBy: null,
  };

  if (!leavesAnInvoice(outcome)) return base;

  const proposal = await proposeMatch(scope, outcome.invoiceId, deps.match);
  if (proposal === null) return { ...base, invoiceId: outcome.invoiceId };

  const decision = proposal.decision;
  const chosen =
    decision.kind === "AUTO_MATCH"
      ? proposal.candidates.find((candidate) => candidate.rank === decision.rank)
      : undefined;

  return {
    ...base,
    invoiceId: outcome.invoiceId,
    candidateTransactionIds: proposal.candidates.map((candidate) => candidate.transaction.id),
    autoMatchTransactionId: chosen?.transaction.id ?? null,
    blockedBy: decision.kind === "NEEDS_REVIEW" ? decision.blockedBy : null,
  };
}

export type SettleOutcome =
  /** The requirement was not waiting on this: resolved meanwhile, or not this workspace's. */
  | { readonly kind: "SKIPPED" }
  | { readonly kind: "SETTLED"; readonly settlement: Settlement; readonly resolved: boolean };

/**
 * Decide what a requirement comes to, from every document retrieved for it, and write it.
 *
 * Only a requirement still `EVALUATING` is settled. One resolved in the meantime -- the
 * user uploaded the invoice while we were reading mail -- is theirs, and nothing here
 * touches it.
 */
export async function settleRetrieval(
  scope: WorkspaceScope,
  requirementId: string,
  assessments: readonly Assessment[],
): Promise<SettleOutcome> {
  const requirement = await scope.selectOne(
    invoiceRequirements,
    eq(invoiceRequirements.id, requirementId),
  );
  if (
    requirement === null ||
    requirement.state !== "EVALUATING" ||
    requirement.resolutionMethod !== null
  ) {
    return { kind: "SKIPPED" };
  }

  const [searches, candidates] = await Promise.all([
    scope.select(mailboxSearches, eq(mailboxSearches.requirementId, requirementId)),
    scope.select(candidateEmails, eq(candidateEmails.requirementId, requirementId)),
  ]);

  /*
   * Whether the cap left anything out, worked out again from the same rows by the same
   * pure function that chose them. Recomputing is cheaper than a column, and cannot
   * disagree with the choice that was made.
   */
  const { exhaustive } = selectForFetching(
    candidates.map((row) => ({
      id: row.id,
      gmailConnectionId: row.gmailConnectionId,
      gmailMessageId: row.gmailMessageId,
      rfc822MessageId: row.rfc822MessageId,
      evidence: row.evidence as EmailEvidence[],
    })),
  );

  const settlement = decideRetrieval({
    transactionId: requirement.canonicalTransactionId,
    assessments,
    // jsonb: whatever was written. Only strings are document ids.
    rejected: new Set(
      (Array.isArray(requirement.rejectedDocumentIds)
        ? requirement.rejectedDocumentIds
        : []
      ).filter((id): id is string => typeof id === "string"),
    ),
    mailboxes: searches.map((search) => ({ outcome: search.outcome, truncated: search.truncated })),
    selectionExhaustive: exhaustive,
  });

  switch (settlement.kind) {
    case "AUTO": {
      const linked = await linkInvoice(
        scope,
        settlement.invoiceId,
        requirement.canonicalTransactionId,
        "AUTO_RETRIEVED",
      );
      if (linked.linked) return { kind: "SETTLED", settlement, resolved: true };

      // The payment already has an invoice, or this one is on another payment. The evidence
      // was good and the link is not possible: a question for the user, not an error.
      await moveRequirement(scope, requirementId, "SETTLED_NEEDS_REVIEW");
      return { kind: "SETTLED", settlement, resolved: false };
    }
    case "NEEDS_REVIEW":
      await moveRequirement(scope, requirementId, "SETTLED_NEEDS_REVIEW");
      break;
    case "NOT_FOUND":
      await moveRequirement(scope, requirementId, "SETTLED_NOT_FOUND");
      break;
    case "BLOCKED":
      await moveRequirement(scope, requirementId, "SETTLED_BLOCKED");
      break;
  }

  return { kind: "SETTLED", settlement, resolved: false };
}
