/**
 * Work out which of a workspace's payments need a supporting document.
 *
 * A thin shell, exactly like `parse-statement.ts`: it turns an event into a scope and calls
 * `identifyRequirements`. The judgment stays in `src/requirements/identify.ts` so it can be
 * tested without Inngest and without a model provider.
 *
 * One function per workspace rather than per statement, because `identifying-invoices.md §8`
 * requires the analysis to span every account the business has. "Is this a transfer to my
 * own account" is a question no single statement can answer.
 */

import { eq } from "drizzle-orm";

import { openWorkspaceForJob } from "../../auth/background";
import { reconciliationRuns } from "../../db/schema";
import { classifyTransactions } from "../../requirements/classifier";
import { identifyRequirements } from "../../requirements/identify";
import { inngest, reconciliationRequested } from "../client";

export const identifyRequirementsFunction = inngest.createFunction(
  {
    id: "identify-requirements",
    /*
     * Identification is idempotent by what it finds: a retry re-reads the workspace and
     * judges only transactions that still carry no requirement, so the second attempt of a
     * run that died halfway finishes it rather than repeating it.
     *
     * Retries exist for the transient half of `§11` -- a provider timeout, a cold database.
     * A model that answered unusably is not retried at all; `identify.ts` records that as a
     * failed run, because `inferStructure` already told us the answer will not improve.
     */
    retries: 3,
    triggers: [reconciliationRequested],
    /*
     * Only one run at a time per workspace.
     *
     * Two concurrent runs would both see the same transactions as unjudged and race on
     * `invoice_requirements_transaction_idx`. The loser's insert collides harmlessly -- that
     * is why the constraint is leaned on rather than checked around -- but the work is
     * wasted and the user sees two runs where one happened. A batch finishing while a run
     * is in flight is the ordinary case, not a rare one.
     */
    concurrency: { key: "event.data.workspaceId", limit: 1 },
    /*
     * Every retry is spent and the run is still sitting in RUNNING.
     *
     * `identifyRequirements` marks its own run failed on the way past, so this covers what
     * it cannot: a crash between opening the run and reaching its own error handling. A run
     * left in RUNNING is a spinner the user watches forever.
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      await scope.update(
        reconciliationRuns,
        { state: "FAILED", finishedAt: new Date() },
        eq(reconciliationRuns.state, "RUNNING"),
      );
    },
  },
  async ({ event, step }) => {
    await step.run("identify", async () => {
      const scope = await openWorkspaceForJob(event.data.userId, event.data.workspaceId);

      return identifyRequirements(scope, { classify: classifyTransactions });
    });
  },
);
