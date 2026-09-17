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
import { inngest, statementBound } from "../client";

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
  },
);
