/**
 * What the business needs documents for.
 *
 * spec: docs/workflows/identifying-invoices.md §5 Step 7, §6 and §10
 *
 * §5 Step 7 asks for a human-readable list, and shows one: vendor, amount, date, and what
 * the payment was. Not a table of transactions -- the whole point of feature E is that this
 * is shorter than the statement it came from.
 *
 * Every word comes from the database. `architecture.md §14` asks exactly that, which is what
 * makes a refresh, or coming back tomorrow, show the truth rather than whatever the browser
 * was holding.
 *
 * ## Why the stages are coarser here than in §6
 *
 * §6 lists five stages -- evaluating, identifying, checking knowledge, awaiting answers,
 * complete -- and is explicit in the same breath that this analysis "does not have a
 * persisted state model of its own". It does not, and nothing writes those five anywhere.
 * Showing all five would mean inventing progress the system is not tracking, which is the
 * same dishonesty as the percentage §6 goes on to forbid, only harder to spot.
 *
 * So the page shows the stages it can actually stand behind: the run is working, the run is
 * done, or the run needs help. The wording is §6's own, for the stages that are real.
 */

import { eq, isNull } from "drizzle-orm";

import Link from "next/link";

import { requireScope } from "../../../auth/workspace";
import {
  bankAccounts,
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  reconciliationRuns,
} from "../../../db/schema";
import { currencyFor } from "../../../money/currencies";
import { formatAmount } from "../../../money/format";
import { PollWhileProcessing } from "../statements/[batchId]/poll";
import styles from "./page.module.css";

/** `docs/workflows/identifying-invoices.md §6`, for the stages that are actually tracked. */
const MESSAGES: Record<string, string> = {
  RUNNING: "Evaluating your transactions…",
  COMPLETED: "We've identified the documents you may need.",
  // §11: the user is told it is our problem, not theirs, and that their statements are safe.
  FAILED: "We ran into an issue analysing your transactions. Your statements are safe.",
};

export default async function ReconciliationPage() {
  const scope = await requireScope();

  // The most recent run is the one the user is watching. Runs are retained -- history is
  // what lets a later run process only what is genuinely new -- so this picks rather than
  // assumes there is one.
  const runs = await scope.select(reconciliationRuns);
  const run = runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

  const [requirements, transactions, accounts, open] = await Promise.all([
    scope.select(invoiceRequirements, eq(invoiceRequirements.state, "IDENTIFIED")),
    scope.select(canonicalTransactions),
    scope.select(bankAccounts),
    scope.select(clarificationQuestions, isNull(clarificationQuestions.answeredAt)),
  ]);

  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const currencyOf = (bankAccountId: string) =>
    currencyFor(accounts.find((account) => account.id === bankAccountId)?.currency);

  const rows = requirements
    .map((requirement) => ({
      requirement,
      transaction: transactionById.get(requirement.canonicalTransactionId),
    }))
    .filter(
      (
        row,
      ): row is {
        requirement: typeof row.requirement;
        transaction: NonNullable<typeof row.transaction>;
      } => Boolean(row.transaction),
    )
    .sort((a, b) => a.transaction.valueDate.localeCompare(b.transaction.valueDate));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Invoices needed</h1>
        <p className={styles.subtitle}>
          {run
            ? (MESSAGES[run.state] ?? run.state)
            : "Upload some statements and we'll take a look."}
        </p>
      </header>

      {open.length > 0 ? (
        <Link className={styles.questions} href="/reconciliation/questions">
          <span className="material-symbols-outlined" aria-hidden="true">
            help
          </span>
          {/* §6's "awaiting answers" stage. It never blocked the run; it is work waiting here. */}
          We need your help with {open.length} {open.length === 1 ? "payment" : "payments"}.
        </Link>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState hasRun={Boolean(run)} />
      ) : (
        <ol className={styles.list}>
          {rows.map(({ requirement, transaction }, position) => (
            <li className={styles.item} key={requirement.id}>
              <span className={styles.position}>{position + 1}</span>
              <div className={styles.detail}>
                <p className={styles.vendor}>
                  {requirement.vendorGuess ?? transaction.description}
                </p>
                <p className={styles.amount}>
                  {(() => {
                    const currency = currencyOf(transaction.bankAccountId);
                    return currency
                      ? formatAmount(transaction.amountMinor, currency)
                      : `${transaction.currency} ${transaction.amountMinor}`;
                  })()}
                </p>
                <p className={styles.date}>{transaction.valueDate}</p>
                {requirement.businessContext ? (
                  <p className={styles.context}>{requirement.businessContext}</p>
                ) : null}
                {requirement.reason ? <p className={styles.reason}>{requirement.reason}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Only while a run is actually moving; a finished run stops asking. */}
      {run?.state === "RUNNING" ? <PollWhileProcessing /> : null}
    </div>
  );
}

/**
 * §10: zero invoice requirements is a valid outcome, "not considered a system failure".
 *
 * Which is why this says what it found rather than apologising, and offers the next thing
 * the user can do -- distinguishing "we looked and there was nothing" from "we have not
 * looked yet", because those are different facts and only one of them is reassuring.
 */
function EmptyState({ hasRun }: { hasRun: boolean }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>
        {hasRun
          ? "We couldn't find any transactions that appear to need invoices."
          : "Nothing to show yet."}
      </p>
      <p className={styles.emptyBody}>
        {hasRun
          ? "You can still upload invoices you already have, once matching arrives."
          : "Upload your bank statements and we'll work out which payments need a document."}
      </p>
      <Link className={styles.emptyAction} href="/statements/upload">
        Upload statements
      </Link>
    </div>
  );
}
