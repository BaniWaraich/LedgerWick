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

import { eq } from "drizzle-orm";

import { openWorkspaceForJob } from "../../auth/background";
import { bankStatements } from "../../db/schema";
import { identifyStatement } from "../../statements/identify";
import { identifyDocument } from "../../statements/document-identifier";
import { getDocumentStore } from "../../storage/blob-store";
import { inngest, statementUploaded } from "../client";

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
     * an expired key. Without this handler the row would stay in IDENTIFYING forever,
     * which is the "failure swallowed rather than recorded as state" that
     * docs/definition-of-done.md forbids, and the polling UI would spin on it.
     *
     * The wording is deliberately about us rather than about their document: nothing here
     * suggests the statement was at fault, because it was not.
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId, statementId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      await scope.update(
        bankStatements,
        {
          state: "FAILED",
          failureReason:
            "Something went wrong on our side while reading this statement. Please try uploading it again.",
        },
        eq(bankStatements.id, statementId),
      );
    },
  },
  async ({ event, step }) => {
    await step.run("identify", async () => {
      const scope = await openWorkspaceForJob(event.data.userId, event.data.workspaceId);
      await identifyStatement(scope, getDocumentStore(), identifyDocument, event.data.statementId);
    });
  },
);
