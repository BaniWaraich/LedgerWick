/**
 * The Missing Invoice Report, read from the workspace.
 *
 * spec: docs/workflows/missing-invoice-report.md §3, §5, §6, §7
 * decision: docs/decisions/0014-report-counts-live-across-the-workspace.md
 *
 * A view over persisted state. Nothing is stored or cached for it, so whatever the review
 * screen or matching last wrote to a requirement is what the next read shows. That is how
 * "resolving an item updates the report immediately" holds (`invoice-match-review.md §11`)
 * without a second source of truth.
 *
 * Every read goes through the scope and there is no join, for the reason
 * `src/requirements/identify.ts` gives: each query then carries the workspace filter, and
 * that guarantee is worth more than the extra round trips.
 */

import { eq, isNull } from "drizzle-orm";

import {
  bankAccounts,
  bankStatements,
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  reconciliationRuns,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { QUEUE_STATES, statesFor, summarize, type Filter, type Summary } from "./summary";

type Requirement = typeof invoiceRequirements.$inferSelect;
type Transaction = typeof canonicalTransactions.$inferSelect;
type Run = typeof reconciliationRuns.$inferSelect;

export interface QueueRow {
  readonly requirement: Requirement;
  readonly transaction: Transaction;
  /** The account's currency, which is what the amount is counted in. */
  readonly accountCurrency: string | null;
}

export interface MissingInvoiceReport {
  /** The latest run: identity, date, state and coverage. Never the counts. */
  readonly run: Run | null;
  /** Accounts with a completed statement -- the statements coverage is read from. */
  readonly accounts: readonly { id: string; name: string }[];
  /** Every canonical transaction in the workspace. Context, never a denominator. */
  readonly transactionsProcessed: number;
  readonly summary: Summary;
  readonly queue: readonly QueueRow[];
  readonly openQuestions: number;
}

export async function missingInvoiceReport(
  scope: WorkspaceScope,
  filter: Filter,
): Promise<MissingInvoiceReport> {
  const [runs, requirements, transactions, accounts, statements, open] = await Promise.all([
    scope.select(reconciliationRuns),
    scope.select(invoiceRequirements),
    scope.select(canonicalTransactions),
    scope.select(bankAccounts),
    scope.select(bankStatements, eq(bankStatements.state, "COMPLETED")),
    scope.select(clarificationQuestions, isNull(clarificationQuestions.answeredAt)),
  ]);

  // Runs are retained so a later one can process only what is new; the latest is the one
  // the report describes.
  const run = runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;

  const covered = new Set(statements.map((statement) => statement.bankAccountId));
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  return {
    run,
    accounts: accounts
      .filter((account) => covered.has(account.id))
      .map((account) => ({
        id: account.id,
        name: [account.bankName, account.accountIdentifier].filter(Boolean).join(" "),
      })),
    transactionsProcessed: transactions.length,
    summary: summarize(requirements),
    queue: queueOf(requirements, transactions, accountById, filter),
    openQuestions: open.length,
  };
}

function queueOf(
  requirements: readonly Requirement[],
  transactions: readonly Transaction[],
  accountById: ReadonlyMap<string, typeof bankAccounts.$inferSelect>,
  filter: Filter,
): QueueRow[] {
  const wanted = new Set<string>(statesFor(filter));
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const rank = (state: string) => QUEUE_STATES.indexOf(state as (typeof QUEUE_STATES)[number]);

  return requirements
    .filter((requirement) => wanted.has(requirement.state))
    .flatMap((requirement) => {
      const transaction = transactionById.get(requirement.canonicalTransactionId);
      if (!transaction) return [];
      return [
        {
          requirement,
          transaction,
          accountCurrency: accountById.get(transaction.bankAccountId)?.currency ?? null,
        },
      ];
    })
    .sort(
      (a, b) =>
        rank(a.requirement.state) - rank(b.requirement.state) ||
        a.transaction.valueDate.localeCompare(b.transaction.valueDate),
    );
}
