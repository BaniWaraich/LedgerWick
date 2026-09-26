/**
 * Judge what retrieval downloaded for one requirement, and settle it.
 *
 * A thin shell. `assessDocument` and `settleRetrieval` in `src/retrieval/assess.ts` hold
 * the judgment, and are tested without Inngest or a model provider.
 *
 * This function reaches models and never Gmail -- the other side of the line
 * `retrieve-documents.ts` holds (`docs/decisions/0016`). It is given document ids and
 * nothing else from the mailbox.
 */

import { eq } from "drizzle-orm";

import { openWorkspaceForJob } from "../../auth/background";
import { invoiceRequirements } from "../../db/schema";
import { readInvoice } from "../../documents/reader";
import { adjudicateMatch, formatForPrompt, judgeSameInvoice } from "../../matching/adjudicator";
import { assessDocument, settleRetrieval, type AssessDeps } from "../../retrieval/assess";
import type { Assessment } from "../../retrieval/decide";
import { documentsFor } from "../../retrieval/fetch";
import { moveRequirement } from "../../retrieval/requirement-state";
import { extractPdfText } from "../../statements/pdf-text";
import { getDocumentStore } from "../../storage/blob-store";
import { inngest, retrievalFetched } from "../client";

function deps(): AssessDeps {
  return {
    understand: { store: getDocumentStore(), extractPdfText, read: readInvoice },
    match: { adjudicate: adjudicateMatch, judgeSameInvoice, formatAmount: formatForPrompt },
  };
}

export const assessRetrievalFunction = inngest.createFunction(
  {
    id: "assess-retrieval",
    /*
     * Retries are for the transient half of `architecture.md §15`: a provider timeout, a
     * gateway with no credit. Understanding and matching record every outcome the domain
     * has a word for, and rethrow only infrastructure.
     */
    retries: 3,
    triggers: [retrievalFetched],
    /*
     * One at a time per workspace, for the reason `match-invoice.ts` gives: two settles
     * linking at once could reach for the same payment. The index would refuse the second,
     * but by then it has spent a model call and told the user a different story.
     */
    concurrency: { key: "event.data.workspaceId", limit: 1 },
    /*
     * Every retry is spent. The requirement becomes `FAILED` rather than sitting in
     * `EVALUATING`, and the next run searches it again. Its documents keep whatever state
     * understanding reached -- a document has no FAILED (`state-machines.md §3`) -- and a
     * later run reuses them rather than downloading again.
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId, requirementId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);
      await moveRequirement(scope, requirementId, "FAILED");
    },
  },
  async ({ event, step }) => {
    const { workspaceId, userId, requirementId } = event.data;

    const documentIds = await step.run("documents", async (): Promise<string[]> => {
      const scope = await openWorkspaceForJob(userId, workspaceId);
      const requirement = await scope.selectOne(
        invoiceRequirements,
        eq(invoiceRequirements.id, requirementId),
      );
      return requirement?.state === "EVALUATING" ? documentsFor(scope, requirementId) : [];
    });

    /*
     * One step per document. A provider timeout on the third document retries the third;
     * the first two are replayed from Inngest's record, not read again.
     */
    const assessments: Assessment[] = [];
    for (const documentId of documentIds) {
      assessments.push(
        await step.run(`assess-${documentId}`, async () => {
          const scope = await openWorkspaceForJob(userId, workspaceId);
          return assessDocument(scope, documentId, deps());
        }),
      );
    }

    return step.run("settle", async () => {
      const scope = await openWorkspaceForJob(userId, workspaceId);
      return settleRetrieval(scope, requirementId, assessments);
    });
  },
);
