/**
 * When an upload batch has finished, and a reconciliation run is due.
 *
 * spec: docs/workflows/identifying-invoices.md §4
 *
 * §4 says the analysis "begins automatically after the relevant uploaded bank statements
 * have been successfully parsed and validated" and that the user never starts it. Feature D
 * is per-file, though, so taking that sentence literally for each statement would start five
 * runs for a five-file upload -- each judging a slice of the same month, and four of them
 * finding most of the work already done.
 *
 * So the unit is the batch. `upload-statement.md §11` is explicit that a batch is a
 * presentation grouping and nothing more, which is exactly what makes it the right trigger:
 * it groups the files the user handed over in one go, which is the same thing as "the
 * statements they want looked at together".
 *
 * ## A statement waiting for its account does not hold up the batch
 *
 * `NEEDS_ACCOUNT` is not in flight. It is waiting for a human, and the run is forbidden from
 * doing that (`docs/architecture.md §12C`, and §6 of this workflow). A batch where one file
 * could not say which account it covers still has four that can be reconciled now, and the
 * fifth rejoins when the user picks: binding sends it back through parsing, which settles
 * the batch again and starts a run over whatever it added.
 *
 * That the second run is cheap is not an accident of this design -- it is the property
 * `identify.ts` is built on, where what counts as new is the absence of a requirement.
 */

import { eq } from "drizzle-orm";

import { bankStatements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

/** The states in which a statement is still being worked on by the system itself. */
const IN_FLIGHT = new Set(["UPLOADING", "IDENTIFYING", "PARSING", "VALIDATING"]);

/**
 * Has every file in this batch reached an outcome the system can act on?
 *
 * Scoped, so a batch id from another workspace reads as an empty batch — and an empty batch
 * is not settled, because there is nothing there to have settled.
 */
export async function batchIsSettled(
  scope: WorkspaceScope,
  uploadBatchId: string,
): Promise<boolean> {
  const statements = await scope.select(
    bankStatements,
    eq(bankStatements.uploadBatchId, uploadBatchId),
  );

  if (statements.length === 0) return false;

  return !statements.some((statement) => IN_FLIGHT.has(statement.state));
}

/**
 * Did this batch leave anything behind for a run to judge?
 *
 * A separate question from `batchIsSettled`, and deliberately a separate function. That one
 * asks whether everything has stopped moving, and its answer has to keep treating `FAILED`
 * as stopped — a batch of five files where one was unreadable must still reconcile the four
 * that were not. Folding "and it produced something" into it would make a settled batch and
 * a productive one the same idea, which they are not: a batch holding one `COMPLETED` file
 * and one `NEEDS_ACCOUNT` file has stopped for now and does have work to do.
 *
 * `COMPLETED` is the test rather than `line_count > 0`, and the difference matters. Parsing
 * fails a statement that yielded no transactions before it can reach `COMPLETED`
 * (`NO_TRANSACTIONS` in `src/statements/parse.ts`), so `COMPLETED` already implies at least
 * one line. `line_count` is nullable, and a null on a row written before it existed would
 * read as "produced nothing" and silently suppress a legitimate run — the kind of wrong
 * answer nobody goes looking for.
 */
export async function batchProducedTransactions(
  scope: WorkspaceScope,
  uploadBatchId: string,
): Promise<boolean> {
  const statements = await scope.select(
    bankStatements,
    eq(bankStatements.uploadBatchId, uploadBatchId),
  );

  return statements.some((statement) => statement.state === "COMPLETED");
}

/**
 * The whole condition for starting a reconciliation run: the batch has stopped, and it left
 * something to judge.
 *
 * Both halves are needed and neither implies the other. Without the first, a run judges half
 * an upload. Without the second, a batch whose every file failed still starts a run, which
 * reads the workspace, finds nothing new, and writes a `COMPLETED` run with nothing in it —
 * a reconciliation the user did not ask for, reporting on an upload that produced no data.
 *
 * `identify.ts` would survive that run: what counts as new there is the absence of a
 * requirement, so an empty delta is a cheap no-op. Surviving it is not a reason to start it.
 */
export async function reconciliationDue(
  scope: WorkspaceScope,
  uploadBatchId: string,
): Promise<boolean> {
  return (
    (await batchIsSettled(scope, uploadBatchId)) &&
    (await batchProducedTransactions(scope, uploadBatchId))
  );
}
