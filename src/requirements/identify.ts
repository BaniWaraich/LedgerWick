/**
 * Deciding which payments need a supporting document.
 *
 * spec: docs/workflows/identifying-invoices.md
 *
 * This is the product's judgment, and the first thing in the system a user would recognise
 * as the reason they came. Everything before it is machinery: statements in, transactions
 * out. This turns a list of payments into a short list of things the business owes a
 * document for, with a reason for each one.
 *
 * ## What makes re-running harmless
 *
 * §5 Step 1: transactions a previous run has already judged are skipped; the run analyzes
 * what is new. `canonical_transactions.judged_at` records a judgment of any kind -- a
 * document is needed, none is, or a question was raised -- and that, not a date window, is
 * what makes a second run cheap and a third run silent.
 *
 * It used to be the absence of a requirement. Most payments need no document, so most of a
 * statement went back to the model on every retry and every later run, and every open
 * question was raised again. The user answering a question is the one thing that reopens a
 * transaction (`answer.ts`), because that run has something new to judge it with.
 *
 * `invoice_requirements_transaction_idx` is the backstop underneath it. Two runs racing on
 * one workspace both see the same transaction as new, and the second insert collides rather
 * than producing a second requirement -- exactly as `promote.ts` leans on the canonical
 * identity index rather than checking first and hoping.
 *
 * ## The run never waits
 *
 * A question is raised and the run keeps going (§6: "Awaiting answers is not a blocking
 * stage"). `docs/architecture.md §12C` forbids a background workflow suspended on a human,
 * and the reason is plainer than the rule: the user may be asleep. A run that stalls on
 * them produces nothing until they wake up, when it could have produced everything else.
 *
 * ## A batch the model could not answer costs that batch
 *
 * Transactions go up in batches, and one batch coming back in a shape the schema rejects
 * says nothing about the other ten. So that batch is recorded as unjudged and the run
 * carries on, rather than returning and calling the run finished — which reported a
 * truncated list as though it were the whole answer, and is the one failure mode here that
 * a user cannot see. The skipped transactions keep no requirement, so the next run picks
 * them up under the same definition of "new" as everything else. So does a transaction the
 * model left out of an otherwise good answer: nothing was decided about it.
 *
 * ## What code decides, and what the model decides
 *
 * The model judges. Code enforces two things it is not allowed to overrule:
 *
 * - A `CREDIT` never produces a requirement. `docs/domain-model.md §11.1` puts refunds and
 *   incoming credits out of V1 scope as a *product* decision, not a deferred design one, so
 *   it is not a judgment call and is not delegated. Money arriving is not an expense the
 *   business needs a bill for.
 * - A transaction the model admits it could not determine produces a question, never a
 *   requirement. The schema in `classify-transactions.v1` already refuses that combination;
 *   this file does not depend on it having been caught there.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";

import { mapWithConcurrency } from "../concurrency";
import type { WorkspaceScope } from "../db/workspace-scope";
import {
  bankAccounts,
  bankStatements,
  businessKnowledge,
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  reconciliationRuns,
} from "../db/schema";
import type { ClassifyTransactions, KnownFact, TransactionBrief } from "./contracts";

/**
 * How many transactions go to the model at once.
 *
 * Not a tuned number -- `docs/architecture.md §21` reserves cost and latency for evaluation
 * against real usage. What bounds it is the time one call takes. At 40, production calls
 * ran 30 to 186 seconds, and one slow answer spent most of a 300-second invocation. At 20,
 * each call is its own step with room to spare, and a failure costs half as much.
 */
const BATCH_SIZE = 20;

/**
 * How many batches are in front of the model at once, at most.
 *
 * Batches share nothing: each judges its own transactions, and the only rows two of them
 * could both want are barred by `invoice_requirements_transaction_idx`. Four because the
 * limit that matters is the provider's. In the workflow Inngest's per-workspace concurrency
 * is tighter still, but this bound holds wherever the steps actually run.
 */
const CLASSIFY_CONCURRENCY = 4;

export interface RunOutcome {
  runId: string;
  state: "COMPLETED" | "FAILED";
  /** Transactions the model actually judged — not the number that were waiting. */
  transactionsProcessed: number;
  documentsRequired: number;
  questionsRaised: number;
  /** Batches whose answer did not fit the schema. Their transactions stay unjudged. */
  batchesFailed: number;
  /** Why it failed, in the user's language. Null when it did not. */
  failure: string | null;
}

/** What one batch settled, kept separate so one batch's failure stays one batch's. */
interface BatchOutcome {
  judged: number;
  documentsRequired: number;
  questionsRaised: number;
  /** The model's answer did not fit the schema. Null when it did. */
  failure: string | null;
}

/**
 * Runs one named piece of the work, and returns what it returned.
 *
 * The workflow passes Inngest's `step.run`, so each piece is kept once it has finished: a
 * retry, or an invocation killed at its time limit, redoes only the piece that did not
 * finish. Everywhere else the piece is simply called. What comes back must survive JSON,
 * which is why the pieces pass ids and counts rather than rows.
 */
export type RunStep = <T>(id: string, work: () => Promise<T>) => Promise<T>;

const inline: RunStep = (_id, work) => work();

/**
 * Analyse everything this workspace has not judged yet, and record what it owes documents for.
 *
 * One run over the whole workspace rather than one per statement: §8 requires the analysis
 * to operate across every account the business has, because "is this a transfer to my own
 * account" is a question no single statement can answer.
 *
 * ## One step per batch
 *
 * All of this used to be one step. On the first production run it made about fifteen model
 * calls, hit Vercel's 300-second limit, and lost every one of them. Inngest then retried the
 * whole step from the start. Now the run opens in one step, each batch is judged in its own,
 * and the run closes in a last one. A batch that has been judged stays judged, whatever
 * happens to the batches after it.
 */
export async function identifyRequirements(
  scope: WorkspaceScope,
  deps: { classify: ClassifyTransactions; step?: RunStep },
): Promise<RunOutcome> {
  const step = deps.step ?? inline;

  const { runId, batches } = await step("start", async () => {
    const [run] = await scope.insert(reconciliationRuns, { state: "RUNNING" });
    const pending = await transactionsAwaitingJudgement(scope);

    const ids = pending.map((transaction) => transaction.id);
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      batches.push(ids.slice(start, start + BATCH_SIZE));
    }
    return { runId: run.id, batches };
  });

  try {
    const outcomes = await mapWithConcurrency(
      batches.map((ids, index) => ({ ids, index })),
      CLASSIFY_CONCURRENCY,
      ({ ids, index }) => step(`judge-${index}`, () => judgeBatch(scope, deps, runId, ids)),
    );

    return await step("finish", () => finishRun(scope, runId, outcomes));
  } catch (error) {
    // A run left in RUNNING is a spinner that never stops. Whatever went wrong, the row
    // says so before the error travels on to Inngest, which decides about retrying.
    await markFailed(scope, runId);
    throw error;
  }
}

/**
 * Close the run with what its batches settled.
 *
 * A run is failed only when nothing could be judged at all.
 *
 * A batch whose answer did not fit the schema costs that batch and no more. The code once
 * returned on the first such batch and abandoned the rest: a workspace of 404 transactions
 * reported five requirements from its earliest days and called itself finished, which is
 * worse than failing, because a truncated list is indistinguishable from a short one.
 *
 * Their transactions simply stay unjudged, which is a state this run already understands --
 * §5 Step 1 defines new as not yet judged, so the next run picks them up with no special
 * handling and no record that they were ever skipped.
 */
async function finishRun(
  scope: WorkspaceScope,
  runId: string,
  outcomes: BatchOutcome[],
): Promise<RunOutcome> {
  const documentsRequired = sum(outcomes, (outcome) => outcome.documentsRequired);
  const questionsRaised = sum(outcomes, (outcome) => outcome.questionsRaised);
  const judged = sum(outcomes, (outcome) => outcome.judged);
  const failures = outcomes.map((outcome) => outcome.failure).filter((r): r is string => !!r);

  if (outcomes.length > 0 && failures.length === outcomes.length) {
    return { ...(await failRun(scope, runId, failures[0])), batchesFailed: failures.length };
  }

  await scope.update(
    reconciliationRuns,
    {
      state: "COMPLETED",
      finishedAt: new Date(),
      // What was judged, not what was waiting. Reporting the waiting count here would
      // describe a partial run as a complete one.
      transactionsProcessed: judged,
      documentsRequired,
      ...(await coverageExamined(scope)),
    },
    eq(reconciliationRuns.id, runId),
  );

  // §10: nothing to collect is a real answer, not a failure.
  return {
    runId,
    state: "COMPLETED",
    transactionsProcessed: judged,
    documentsRequired,
    questionsRaised,
    batchesFailed: failures.length,
    failure: failures[0] ?? null,
  };
}

/**
 * Judge one batch, and report what it settled rather than acting on the run as a whole.
 *
 * Every write here is scoped to the transactions of this batch, so two batches in flight at
 * once cannot write the same row — which is what makes running them concurrently a latency
 * decision rather than a correctness one.
 *
 * An infrastructure failure is not caught: `inferStructure` rethrows those precisely so the
 * workflow retries them, and swallowing one here would turn a gateway outage into a
 * permanently unjudged batch.
 */
async function judgeBatch(
  scope: WorkspaceScope,
  deps: { classify: ClassifyTransactions },
  runId: string,
  ids: string[],
): Promise<BatchOutcome> {
  // Read again rather than carried over from `start`. Only ids survive a step boundary,
  // and a row judged since -- by an earlier attempt of this step -- drops out here instead
  // of being paid for twice.
  const rows = await transactionsAwaitingJudgement(scope, ids);
  if (rows.length === 0) {
    return { judged: 0, documentsRequired: 0, questionsRaised: 0, failure: null };
  }

  const judgements = await deps.classify({
    transactions: rows.map((transaction, index) => brief(transaction, index)),
    known: await knownFacts(scope),
  });

  if (!judgements.ok) {
    // The model answered and the answer was unusable. An outcome about this batch, and only
    // this batch: its transactions keep no requirement, so the next run treats them as new.
    return { judged: 0, documentsRequired: 0, questionsRaised: 0, failure: judgements.reason };
  }

  let documentsRequired = 0;
  let questionsRaised = 0;
  const answered = new Set<string>();

  for (const judgement of judgements.value.judgements) {
    const subject = rows[judgement.index];
    // A judgment about a transaction that was not in the batch is not a transaction we are
    // entitled to write against. Dropping it is right: the model answering about row 500 of
    // a 20-row list has told us nothing about row 500.
    if (!subject) continue;
    // The model answering twice about one row settles it once.
    if (answered.has(subject.id)) continue;
    answered.add(subject.id);

    if (!judgement.confident && judgement.clarification) {
      await scope.insert(clarificationQuestions, {
        canonicalTransactionId: subject.id,
        reconciliationRunId: runId,
        question: judgement.clarification.question,
        // Kept so the answer has something to generalize over. See the column comment.
        vendorGuess: judgement.vendorGuess,
        options: judgement.clarification.options,
      });
      questionsRaised += 1;
      continue;
    }

    if (!judgement.needsDocument) continue;
    // Money arriving is not an expense. docs/domain-model.md §11.1.
    if (subject.direction === "CREDIT") continue;

    const created = await createRequirement(scope, {
      canonicalTransactionId: subject.id,
      reconciliationRunId: runId,
      reason: judgement.reason,
      vendorGuess: judgement.vendorGuess,
      businessContext: judgement.businessContext,
    });
    if (created) documentsRequired += 1;
  }

  if (answered.size > 0) {
    await scope.update(
      canonicalTransactions,
      { judgedAt: new Date() },
      inArray(canonicalTransactions.id, [...answered]),
    );
  }

  return { judged: answered.size, documentsRequired, questionsRaised, failure: null };
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}

/**
 * The transactions no run has judged yet.
 *
 * A requirement is still checked as well as `judged_at`. It costs one read, and a
 * transaction that already has a requirement must never go back to the model, whatever
 * the timestamp says.
 *
 * Two reads and a filter rather than a join, because `WorkspaceScope` deliberately exposes
 * no join: every query it issues carries the workspace filter, and that guarantee is worth
 * more than the query being one round trip. Both reads are scoped, so a transaction from
 * another workspace cannot appear here however the data is shaped.
 */
async function transactionsAwaitingJudgement(scope: WorkspaceScope, ids?: string[]) {
  const unjudged = isNull(canonicalTransactions.judgedAt);
  const [transactions, existing] = await Promise.all([
    scope.select(
      canonicalTransactions,
      ids ? and(unjudged, inArray(canonicalTransactions.id, ids)) : unjudged,
    ),
    scope.select(invoiceRequirements),
  ]);

  const judged = new Set(existing.map((requirement) => requirement.canonicalTransactionId));
  const accounts = await accountNames(scope);

  return transactions
    .filter((transaction) => !judged.has(transaction.id))
    .sort((a, b) => a.valueDate.localeCompare(b.valueDate))
    .map((transaction) => ({
      ...transaction,
      account: accounts.get(transaction.bankAccountId) ?? "this account",
    }));
}

async function accountNames(scope: WorkspaceScope): Promise<Map<string, string>> {
  const accounts = await scope.select(bankAccounts);
  return new Map(
    accounts.map((account) => [
      account.id,
      [account.bankName, account.accountIdentifier].filter(Boolean).join(" "),
    ]),
  );
}

/** Everything the user has confirmed about their business. §5 Step 4. */
async function knownFacts(scope: WorkspaceScope): Promise<KnownFact[]> {
  const facts = await scope.select(businessKnowledge);
  return facts.map((fact) => ({ kind: fact.kind, key: fact.key, value: fact.value }));
}

function brief(
  transaction: Awaited<ReturnType<typeof transactionsAwaitingJudgement>>[number],
  index: number,
): TransactionBrief {
  return {
    index,
    valueDate: transaction.valueDate,
    amountMinor: transaction.amountMinor,
    direction: transaction.direction,
    currency: transaction.currency,
    description: transaction.description,
    account: transaction.account,
  };
}

/**
 * Write one requirement, tolerating the one that is already there.
 *
 * `promote.ts` takes the same position on the canonical identity index, and for the same
 * reason: checking first and inserting second is two statements with a gap in the middle,
 * and the constraint is the thing that is actually true. A collision here means another run
 * judged this transaction first, which is a race and not an error.
 */
async function createRequirement(
  scope: WorkspaceScope,
  values: {
    canonicalTransactionId: string;
    reconciliationRunId: string;
    reason: string | null;
    vendorGuess: string | null;
    businessContext: string | null;
  },
): Promise<boolean> {
  try {
    await scope.insert(invoiceRequirements, { ...values, state: "IDENTIFIED" });
    return true;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return false;
  }
}

/**
 * The span of statement periods this workspace has provided.
 *
 * §9 asks the run to carry coverage so gaps can be reported later. There is no coverage
 * table -- `docs/decisions/0008` settled that a statement's own period is the record, and
 * `bank_statements_coverage_idx` is what makes reading it cheap.
 */
async function coverageExamined(scope: WorkspaceScope) {
  const statements = await scope.select(bankStatements, eq(bankStatements.state, "COMPLETED"));

  const starts = statements.map((s) => s.periodStart).filter((v): v is string => v !== null);
  const ends = statements.map((s) => s.periodEnd).filter((v): v is string => v !== null);

  return {
    coverageStart: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
    coverageEnd: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

async function failRun(scope: WorkspaceScope, runId: string, reason: string): Promise<RunOutcome> {
  await markFailed(scope, runId);
  return {
    runId,
    state: "FAILED",
    transactionsProcessed: 0,
    documentsRequired: 0,
    questionsRaised: 0,
    batchesFailed: 0,
    failure: reason,
  };
}

async function markFailed(scope: WorkspaceScope, runId: string): Promise<void> {
  await scope.update(
    reconciliationRuns,
    { state: "FAILED", finishedAt: new Date() },
    eq(reconciliationRuns.id, runId),
  );
}

function isUniqueViolation(error: unknown): boolean {
  const pg = ((error as { cause?: unknown })?.cause ?? error) as { code?: string };
  return pg?.code === "23505";
}
