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
  },
  async ({ event, step }) => {
    await step.run("identify", async () => {
      const scope = await openWorkspaceForJob(event.data.userId, event.data.workspaceId);
      await identifyStatement(scope, getDocumentStore(), identifyDocument, event.data.statementId);
    });
  },
);
