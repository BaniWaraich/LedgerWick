/**
 * The questions the system could not answer for itself.
 *
 * spec: docs/workflows/identifying-invoices.md §7
 *
 * These were raised during a run that did not wait for them (§6), which is why they are a
 * page of their own rather than a modal in the middle of one. The user may be answering
 * these days later, and everything they need to answer is on the row: the payment, the
 * amount, the date, and what was asked.
 *
 * §7 requires the answers be specific and answerable without technical knowledge, so they
 * are the options the question came with — not a free-text box asking a business owner to
 * describe their own vendor to a computer.
 */

import { isNull } from "drizzle-orm";

import Link from "next/link";

import { requireScope } from "../../../../auth/workspace";
import { bankAccounts, canonicalTransactions, clarificationQuestions } from "../../../../db/schema";
import { currencyFor } from "../../../../money/currencies";
import { formatAmount } from "../../../../money/format";
import { AnswerForm } from "./answer-form";
import styles from "./page.module.css";

export default async function QuestionsPage() {
  const scope = await requireScope();

  const [questions, transactions, accounts] = await Promise.all([
    scope.select(clarificationQuestions, isNull(clarificationQuestions.answeredAt)),
    scope.select(canonicalTransactions),
    scope.select(bankAccounts),
  ]);

  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>A few questions</h1>
        <p className={styles.subtitle}>
          We couldn&rsquo;t tell what these payments were. Your answers stay with your business, so
          we only ask once.
        </p>
      </header>

      {questions.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing to answer.</p>
          <Link className={styles.emptyAction} href="/reconciliation">
            Back to invoices needed
          </Link>
        </div>
      ) : (
        <ul className={styles.list}>
          {questions.map((question) => {
            const transaction = question.canonicalTransactionId
              ? transactionById.get(question.canonicalTransactionId)
              : undefined;
            const currency = transaction
              ? currencyFor(
                  accounts.find((account) => account.id === transaction.bankAccountId)?.currency,
                )
              : null;

            return (
              <li className={styles.item} key={question.id}>
                {transaction ? (
                  <p className={styles.payment}>
                    {currency
                      ? formatAmount(transaction.amountMinor, currency)
                      : `${transaction.currency} ${transaction.amountMinor}`}{" "}
                    · {transaction.description} · {transaction.valueDate}
                  </p>
                ) : null}

                <p className={styles.question}>{question.question}</p>

                <AnswerForm questionId={question.id} options={optionsOf(question.options)} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The options as the question stored them.
 *
 * `jsonb` is `unknown` to the type system and the row was written by a workflow that has
 * since been changed more than once, so this checks rather than casts. A question whose
 * options did not survive is still answerable — `AnswerForm` falls back to a text box —
 * which is better than a page that throws because one row is odd.
 */
function optionsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((option): option is string => typeof option === "string");
}
