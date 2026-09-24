/**
 * Find the payment one invoice was for.
 *
 * A thin shell, exactly like `understand-document.ts` and `identify-requirements.ts`: it
 * turns an event into a scope and calls `matchInvoice`. Every judgment stays in
 * `src/matching/`, so it can be tested without Inngest and without a model provider.
 */

import { openWorkspaceForJob } from "../../auth/background";
import { adjudicateMatch, formatForPrompt, judgeSameInvoice } from "../../matching/adjudicator";
import { matchInvoice } from "../../matching/match";
import { invoiceExtracted, inngest } from "../client";

export const matchInvoiceFunction = inngest.createFunction(
  {
    id: "match-invoice",
    /*
     * Retries are for the transient half of `architecture.md §15`. `matchInvoice` returns
     * every outcome the domain has a word for -- linked, needs review, not found, a
     * suspected duplicate -- and lets only infrastructure escape, so a retry here always
     * means something that might work next time.
     *
     * Safe to retry because it is idempotent by what it finds: an invoice already carrying
     * a payment is finished, and the candidate set is replaced rather than added to.
     */
    retries: 3,
    triggers: [invoiceExtracted],
    /*
     * One invoice at a time per workspace.
     *
     * For correctness here, unlike `understand-document` where it guards vendor rows. Two
     * invoices matching at once can pick the same payment, and while
     * `invoices_transaction_idx` would refuse the second write, the loser has by then
     * spent a model call and told the user a different story. Serialising is cheaper than
     * explaining the race.
     */
    concurrency: { key: "event.data.workspaceId", limit: 1 },
    /*
     * No `onFailure`.
     *
     * There is no state on an invoice that means "matching gave up", and inventing one
     * would make an exhausted retry look like a verdict about the document -- the same
     * argument `understand-document.ts` makes for a Supporting Document having no FAILED
     * state. An invoice that never matched is simply unlinked, which is true, and it is
     * still manually linkable from the document's own screen.
     *
     * The requirement is the thing with a state, and it keeps whichever it had. A
     * requirement stuck in EVALUATING is one the system did not finish with, which is
     * again the truth, and the next upload or run moves it.
     */
  },
  async ({ event, step }) =>
    step.run("match", async () => {
      const { workspaceId, userId, invoiceId } = event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      return matchInvoice(scope, invoiceId, {
        adjudicate: adjudicateMatch,
        judgeSameInvoice,
        formatAmount: formatForPrompt,
      });
    }),
);
