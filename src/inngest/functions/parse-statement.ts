/**
 * Parse one bound statement.
 *
 * A thin shell, exactly like `identify-statement.ts`: it turns an event into a scope and
 * calls `parseStatement`. The decision logic stays in `src/statements/parse.ts` so it can be
 * tested without Inngest and without a model provider.
 *
 * One function per statement, because `upload-statement.md §11` requires files in a batch to
 * succeed and fail independently — and a per-file run is what makes that true of retries too.
 */

import { openWorkspaceForJob } from "../../auth/background";
import { mapColumns } from "../../statements/column-mapper";
import { parseStatement, recordTerminalParseFailure } from "../../statements/parse";
import { extractPdfText } from "../../statements/pdf-text";
import { readScanned } from "../../statements/scanned-reader";
import { getDocumentStore } from "../../storage/blob-store";
import { eq } from "drizzle-orm";

import { reconciliationDue } from "../../requirements/batch";
import { bankStatements } from "../../db/schema";
import { inngest, reconciliationRequested, statementBound } from "../client";

export const parseStatementFunction = inngest.createFunction(
  {
    id: "parse-statement",
    /*
     * Parsing is idempotent by the statement's own state and by its lines, so a retry
     * re-reads the row and either continues or stops. Retries exist for the transient half
     * of `§15` -- a provider timeout, a cold database -- not to force a second opinion out
     * of the model.
     *
     * ADR 0003's single re-derive is a different thing entirely and lives inside
     * `parseStatement`, where it can be told what did not reconcile and be withheld from
     * the scanned path.
     */
    retries: 3,
    triggers: [statementBound],
    /*
     * Every retry is spent and the statement is still sitting in PARSING.
     *
     * `inferStructure` rethrows infrastructure failures rather than reporting them as an
     * unreadable document, which is what gets us here. Without this the row would wait in
     * PARSING forever and the polling UI would spin on it -- the "failure swallowed rather
     * than recorded as state" that `docs/definition-of-done.md` forbids.
     */
    onFailure: async ({ event }) => {
      const { workspaceId, userId, statementId } = event.data.event.data;
      const scope = await openWorkspaceForJob(userId, workspaceId);

      await recordTerminalParseFailure(scope, statementId);

      // A batch whose last file failed is still a finished batch. Staying quiet here would
      // mean the run waits for a success that is never coming, and the other files in the
      // upload would never be reconciled because one of them was unreadable. What the
      // announcement no longer does is start a run for a batch where nothing succeeded --
      // see `reconciliationDue`.
      await announceParsed(scope, statementId, workspaceId, userId);
    },
  },
  async ({ event, step }) => {
    await step.run("parse", async () => {
      const scope = await openWorkspaceForJob(event.data.userId, event.data.workspaceId);

      await parseStatement(
        scope,
        {
          store: getDocumentStore(),
          extractPdfText,
          mapColumns,
          readScanned,
        },
        event.data.statementId,
      );
    });

    /*
     * Whether this file's batch has finished and has anything to show for it.
     *
     * A query rather than a decision, which is why it is allowed to live in the shell --
     * `reconciliationDue` holds both halves of the rule: what "finished" means, including
     * that a statement waiting for the user to pick an account does not count as unfinished,
     * and that a batch which produced no transactions has nothing for a run to judge.
     */
    const due = await step.run("batch-settled", async () => {
      const scope = await openWorkspaceForJob(event.data.userId, event.data.workspaceId);
      const statement = await scope.selectOne(
        bankStatements,
        eq(bankStatements.id, event.data.statementId),
      );
      if (!statement) return null;

      return (await reconciliationDue(scope, statement.uploadBatchId))
        ? statement.uploadBatchId
        : null;
    });

    // Sent through `step` for the reason `identify-statement.ts` gives: a crash between
    // finishing the parse and starting the run would otherwise leave a workspace full of
    // transactions that nothing ever judges.
    if (due) {
      await step.sendEvent("identify-requirements", [
        reconciliationRequested.create({
          workspaceId: event.data.workspaceId,
          userId: event.data.userId,
        }),
      ]);
    }
  },
);

/**
 * Tell the system this statement has stopped moving, from the failure path.
 *
 * `onFailure` runs outside the step machinery, so this sends directly. The event is the
 * same one the success path raises; what happens next is a question about the batch, and
 * the batch does not care why a file stopped -- only whether any of them got anywhere.
 *
 * So a batch that ends with one file parsed and one failed still raises the event, and a
 * batch where every file failed does not. The second used to, and started a reconciliation
 * run over an upload that had produced nothing: a run the user did not ask for, reporting on
 * data that does not exist.
 */
async function announceParsed(
  scope: Awaited<ReturnType<typeof openWorkspaceForJob>>,
  statementId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  if (!statement) return;

  if (!(await reconciliationDue(scope, statement.uploadBatchId))) return;

  await inngest.send(reconciliationRequested.create({ workspaceId, userId }));
}
