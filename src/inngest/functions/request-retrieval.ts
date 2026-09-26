/**
 * Turn "search this workspace's mailboxes" into one search per requirement.
 *
 * A thin shell: `requirementsToSearch` decides which, and this sends one event for each. A
 * search per requirement rather than one for the workspace, so that a failure searching for
 * one payment's document cannot take the others with it.
 */

import { openWorkspaceForJob } from "../../auth/background";
import { requirementsToSearch } from "../../retrieval/eligible";
import { inngest, requirementRetrievalRequested, retrievalRequested } from "../client";

export const requestRetrievalFunction = inngest.createFunction(
  {
    id: "request-retrieval",
    retries: 3,
    triggers: [retrievalRequested],
    /*
     * One fan-out at a time per workspace. A run finishing while the user reconnects a
     * mailbox would otherwise send the same requirements twice. The second copies would be
     * harmless -- a search is idempotent and one runs at a time -- but they are work for
     * nothing.
     */
    concurrency: { key: "event.data.workspaceId", limit: 1 },
  },
  async ({ event, step }) => {
    const { workspaceId, userId } = event.data;

    const requirementIds = await step.run("eligible", async () => {
      const scope = await openWorkspaceForJob(userId, workspaceId);
      return requirementsToSearch(scope);
    });

    if (requirementIds.length > 0) {
      await step.sendEvent(
        "search-each",
        requirementIds.map((requirementId) =>
          requirementRetrievalRequested.create({ workspaceId, userId, requirementId }),
        ),
      );
    }

    return { requirements: requirementIds.length };
  },
);
