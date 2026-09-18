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
 * §5 Step 1: "Transactions already carrying an Invoice Requirement from a previous run are
 * skipped; the run analyzes what is new." That sentence, and not a date window, is what
 * makes a second run cheap and a third run silent. A date window would re-judge everything
 * inside it and re-create what the user had already resolved; the absence of a requirement
 * is the only honest definition of "new", because it survives the user deleting statements,
 * uploading overlapping ones, and resolving requirements in between.
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
 * them up under the same definition of "new" as everything else.
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

import { eq } from "drizzle-orm";

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
 * Not a tuned number and deliberately not presented as one -- `docs/architecture.md §21`
 * reserves cost and latency for evaluation against real usage. It is large enough that a
 * month of statements is a handful of calls rather than one per row, and small enough that
 * a single failure does not cost the whole run.
 */
const BATCH_SIZE = 40;

/**
 * How many batches are in front of the model at once.
 *
 * Batches share nothing. Each judges its own slice of transactions, and the only rows two
 * of them could both want are barred by `invoice_requirements_transaction_idx` — which
 * `createRequirement` already leans on, because a race there was always possible between
 * two runs.
 *
 * Serial was not a safety property, it was the default, and it cost the run everything: a
 * workspace of 404 transactions is eleven batches, and at the ~50 seconds a call takes that
 * is ~570 seconds against a function that is killed at 300. The run could not finish, and
 * a run that cannot finish reports a truncated list as though it were the answer.
 *
 * Four rather than eleven because the limit that matters is the provider's, not ours. This
 * is deliberately conservative: `docs/architecture.md §21` reserves cost and latency for
 * evaluation, and being rate limited would turn a slow run into a failed one.
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
 * Analyse everything this workspace has not judged yet, and record what it owes documents for.
 *
 * One run over the whole workspace rather than one per statement: §8 requires the analysis
 * to operate across every account the business has, because "is this a transfer to my own
 * account" is a question no single statement can answer.
 */
export async function identifyRequirements(
  scope: WorkspaceScope,
  deps: { classify: ClassifyTransactions },
): Promise<RunOutcome> {
  const [run] = await scope.insert(reconciliationRuns, { state: "RUNNING" });

  try {
    const pending = await transactionsAwaitingJudgement(scope);
    const known = await knownFacts(scope);

    const batches: { start: number; rows: typeof pending }[] = [];
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      batches.push({ start, rows: pending.slice(start, start + BATCH_SIZE) });
    }

    const outcomes = await mapWithConcurrency(batches, CLASSIFY_CONCURRENCY, (batch) =>
      judgeBatch(scope, deps, run.id, batch, known),
    );

    const documentsRequired = sum(outcomes, (outcome) => outcome.documentsRequired);
    const questionsRaised = sum(outcomes, (outcome) => outcome.questionsRaised);
    const judged = sum(outcomes, (outcome) => outcome.judged);
    const failures = outcomes.map((outcome) => outcome.failure).filter((r): r is string => !!r);

    /*
     * A run is failed only when nothing could be judged at all.
     *
     * A batch whose answer did not fit the schema costs that batch and no more -- which is
     * what `BATCH_SIZE` above always claimed, and what the code did not do: it returned on
     * the first such batch and abandoned the rest. A workspace of 404 transactions reported
     * five requirements from its earliest days and called itself finished, which is worse
     * than failing, because a truncated list is indistinguishable from a short one.
     *
     * Their transactions simply stay unjudged, which is a state this run already understands
     * -- §5 Step 1 defines new as the absence of a requirement, so the next run picks them up
     * with no special handling and no record that they were ever skipped.
     */
    const everyBatchFailed = batches.length > 0 && failures.length === batches.length;
    const coverage = await coverageExamined(scope);

    if (everyBatchFailed) {
      return { ...(await failRun(scope, run.id, failures[0])), batchesFailed: failures.length };
    }

    await scope.update(
      reconciliationRuns,
      {
        state: "COMPLETED",
        finishedAt: new Date(),
        // What was judged, not what was waiting. Reporting `pending.length` here would
        // describe a partial run as a complete one, which is the reporting half of the bug
        // above.
        transactionsProcessed: judged,
        documentsRequired,
        ...coverage,
      },
      eq(reconciliationRuns.id, run.id),
    );

    // §10: nothing to collect is a real answer, not a failure.
    return {
      runId: run.id,
      state: "COMPLETED",
      transactionsProcessed: judged,
      documentsRequired,
      questionsRaised,
      batchesFailed: failures.length,
      failure: failures[0] ?? null,
    };
  } catch (error) {
    // A run left in RUNNING is a spinner that never stops. Whatever went wrong, the row
    // says so before the error travels on to Inngest, which decides about retrying.
    await markFailed(scope, run.id);
    throw error;
  }
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
  batch: { start: number; rows: Awaited<ReturnType<typeof transactionsAwaitingJudgement>> },
  known: KnownFact[],
): Promise<BatchOutcome> {
  const { start, rows } = batch;

  const judgements = await deps.classify({
    transactions: rows.map((transaction, offset) => brief(transaction, start + offset)),
    known,
  });

  if (!judgements.ok) {
    // The model answered and the answer was unusable. An outcome about this batch, and only
    // this batch: its transactions keep no requirement, so the next run treats them as new.
    return { judged: 0, documentsRequired: 0, questionsRaised: 0, failure: judgements.reason };
  }

  let documentsRequired = 0;
  let questionsRaised = 0;

  for (const judgement of judgements.value.judgements) {
    const subject = rows[judgement.index - start];
    // A judgment about a transaction that was not in the batch is not a transaction we are
    // entitled to write against. Dropping it is right: the model answering about row 500 of
    // a 40-row list has told us nothing about row 500.
    if (!subject) continue;

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

  return { judged: rows.length, documentsRequired, questionsRaised, failure: null };
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}

/**
 * The transactions no run has judged yet.
 *
 * Two reads and a filter rather than a join, because `WorkspaceScope` deliberately exposes
 * no join: every query it issues carries the workspace filter, and that guarantee is worth
 * more than the query being one round trip. Both reads are scoped, so a transaction from
 * another workspace cannot appear here however the data is shaped.
 */
async function transactionsAwaitingJudgement(scope: WorkspaceScope) {
  const [transactions, existing] = await Promise.all([
    scope.select(canonicalTransactions),
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
