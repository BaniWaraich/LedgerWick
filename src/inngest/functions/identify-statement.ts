/**
 * Identify one uploaded statement.
 *
 * A thin shell: it turns an event into a scope and calls `identifyStatement`. The decision
 * logic stays in `src/statements/identify.ts` so it can be tested without Inngest, in the
 * same way route handlers here stay adapters over testable functions.
 *
 * One function per statement, because `upload-statement.md §11` requires files in a batch
 * to succeed and fail independently — a per-file run is what makes that true of retries
 * too.
 */

import { openWorkspaceForJob } from "../../auth/background";
import { identifyStatement, recordTerminalFailure } from "../../statements/identify";
import { identifyDocument } from "../../statements/document-identifier";
import { getDocumentStore } from "../../storage/blob-store";
import { inngest, statementBound, statementUploaded } from "../client";

export const identifyStatementFunction = inngest.createFunction(
  {
    id: "identify-statement",
    // Identification is idempotent by the statement's own state, so a retry re-reads the
    // row and stops if it has already moved on. Retries exist for the transient half of
    // §15 — a provider timeout, a cold database — not to force a second opinion out of the
    // model.
    retries: 3,
    triggers: [statementUploaded],
    /*
     * Every retry is spent and the statement is still sitting in IDENTIFYING.
     *
     * `inferStructure` rethrows infrastructure failures rather than reporting them as an
     * unreadable document, which is what gets us here — a gateway outage, a lapsed card,
     * an expired key. The recording itself lives in `src/statements/identify.ts` for the
     * same reason the rest of the decision logic does: this file is a shell, and a shell
     * cannot be tested.
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId, statementId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      await recordTerminalFailure(scope, statementId);
    },
  },
  async ({ event, step }) => {
    const outcome = await step.run("identify", async () => {
      const scope = await openWorkspaceForJob(event.data.userId, event.data.workspaceId);
      return identifyStatement(scope, getDocumentStore(), identifyDocument, event.data.statementId);
    });

    // Only a statement that reached PARSING has anything left to do. Sent through `step` so
    // it is durable: a crash between the binding and the send would otherwise leave a bound
    // statement that nothing ever parses.
    if (outcome === "BOUND") {
      await step.sendEvent("parse", [
        statementBound.create({
          statementId: event.data.statementId,
          workspaceId: event.data.workspaceId,
          userId: event.data.userId,
        }),
      ]);
    }
  },
);
