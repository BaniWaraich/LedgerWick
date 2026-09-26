/**
 * Search one requirement's mailboxes for its document.
 *
 * A thin shell, like `match-invoice.ts`: it turns an event into a scope and calls
 * `searchRequirement`. The judgment stays in `src/retrieval/` so it can be tested without
 * Inngest and without Google.
 *
 * This function reaches Gmail and never a model. `docs/decisions/0016` splits retrieval at
 * exactly that line, and `tests/gmail/boundary.test.ts` holds it.
 */

import { NonRetriableError } from "inngest";

import { openWorkspaceForJob } from "../../auth/background";
import { gmailClient } from "../../gmail/mail";
import { googleOAuthClient } from "../../gmail/oauth";
import { moveRequirement } from "../../retrieval/requirement-state";
import { isPermanentFailure, searchRequirement } from "../../retrieval/search";
import { inngest, requirementRetrievalRequested } from "../client";

export const retrieveDocumentsFunction = inngest.createFunction(
  {
    id: "retrieve-documents",
    /*
     * Retries are for the transient half of `retrieve-invoices.md §18`: a rate limit, a 5xx,
     * a network blip. `searchRequirement` records an authorization problem as state and
     * returns, so a retry here always means something that might work next time. A
     * misconfiguration is thrown as non-retriable, because `§18` also says "the system
     * should not retry indefinitely".
     */
    retries: 3,
    triggers: [requirementRetrievalRequested],
    /*
     * One search at a time per workspace.
     *
     * For Gmail's sake as much as ours: every requirement in a workspace searches the same
     * mailboxes, and Google's per-user rate limit is shared between them. It also means one
     * requirement is never searched by two runs at once.
     */
    concurrency: { key: "event.data.workspaceId", limit: 1 },
    /*
     * Every retry is spent. The requirement must not sit in `SEARCHING` looking busy: it
     * becomes `FAILED`, which the report shows as "We hit a problem — we'll retry", and the
     * next reconciliation run searches it again (`docs/state-machines.md §2`).
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId, requirementId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);
      await moveRequirement(scope, requirementId, "FAILED");
    },
  },
  async ({ event, step }) =>
    step.run("search", async () => {
      const { workspaceId, userId, requirementId } = event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      try {
        return await searchRequirement(scope, requirementId, {
          oauth: googleOAuthClient(),
          gmail: gmailClient(),
        });
      } catch (error) {
        // The error's name only. A Google failure never carries a token (`oauth.ts`).
        if (isPermanentFailure(error)) {
          throw new NonRetriableError(error instanceof Error ? error.name : "config");
        }
        throw error;
      }
    }),
);
