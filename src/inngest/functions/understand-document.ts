/**
 * Work out what one stored supporting document is, and what it says.
 *
 * A thin shell, exactly like `parse-statement.ts` and `identify-requirements.ts`: it turns
 * an event into a scope and calls `understandDocument`. The judgment stays in
 * `src/documents/understand.ts` so it can be tested without Inngest and without a model
 * provider.
 */

import { openWorkspaceForJob } from "../../auth/background";
import { readInvoice } from "../../documents/reader";
import { leavesAnInvoice, understandDocument } from "../../documents/understand";
import { extractPdfText } from "../../statements/pdf-text";
import { getDocumentStore } from "../../storage/blob-store";
import { documentStored, inngest, invoiceExtracted } from "../client";

export const understandDocumentFunction = inngest.createFunction(
  {
    id: "understand-document",
    /*
     * Retries exist for the transient half of `architecture.md §15` -- a provider timeout,
     * a gateway with no credit, a cold database. `understandDocument` rethrows exactly
     * those and records everything else as state, so a retry here always means something
     * that might work next time.
     *
     * A document is safe to retry because it is idempotent by what it finds: one already in
     * a terminal state is left alone, and one whose first attempt died after writing its
     * invoice is finished rather than duplicated.
     */
    retries: 3,
    triggers: [documentStored],
    /*
     * One document at a time per workspace.
     *
     * Not for correctness -- the unique index on vendor_aliases already settles the race
     * two documents from one vendor would otherwise have. It is for the vendor rows that
     * race would strand: the loser keeps a vendor nothing can find, and feature K fetching
     * a dozen attachments at once would make that the common case rather than a rare one.
     * The merge screen that would tidy them is deferred by phase-1.md §3.
     */
    concurrency: { key: "event.data.workspaceId", limit: 1 },
    /*
     * No `onFailure`.
     *
     * `docs/state-machines.md §3` says why: a Supporting Document has no FAILED state, and
     * giving it one would make an exhausted retry look like a verdict on the document. A
     * document left in EXTRACTING or CLASSIFYING is one the system did not finish with,
     * which is the truth, and it stays stored and manually linkable either way. That is the
     * opposite of a statement, where a stuck row is a spinner the user watches forever.
     */
  },
  async ({ event, step }) => {
    const { workspaceId, userId, documentId } = event.data;

    const outcome = await step.run("understand", async () => {
      const scope = await openWorkspaceForJob(userId, workspaceId);

      return understandDocument(scope, documentId, {
        store: getDocumentStore(),
        extractPdfText,
        read: readInvoice,
      });
    });

    if (leavesAnInvoice(outcome)) {
      await step.sendEvent("match", [
        invoiceExtracted.create({ workspaceId, userId, invoiceId: outcome.invoiceId }),
      ]);
    }

    return outcome;
  },
);
