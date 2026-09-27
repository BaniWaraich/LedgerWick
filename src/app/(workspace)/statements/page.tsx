/**
 * Every statement this business has uploaded, and where each one got to.
 *
 * spec: docs/workflows/upload-statement.md §14
 *
 * The batch page is where an upload is watched while it runs. This is where a user comes
 * back to it later: to find a file that failed, finish one still waiting for its account,
 * or open the transactions of one that finished. Each upload leads to its batch page, and
 * each completed statement to its transactions, so this page shows and links, and does no
 * work of its own.
 *
 * Every word comes from the database (`architecture.md §14`), through `statementHistory`.
 */

import Link from "next/link";

import { requireScope } from "../../../auth/workspace";
import { currencyFor } from "../../../money/currencies";
import { formatAmount } from "../../../money/format";
import { statementHistory, type HistoryStatement } from "../../../statements/history";
import { STATEMENT_IN_FLIGHT, STATEMENT_MESSAGES } from "../../../statements/messages";
import { PollWhileProcessing } from "./[batchId]/poll";
import styles from "./page.module.css";

export default async function StatementsPage() {
  const scope = await requireScope();
  const uploads = await statementHistory(scope);
  const moving = uploads.some((upload) =>
    upload.statements.some((statement) => STATEMENT_IN_FLIGHT.has(statement.state)),
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <h1 className={styles.title}>Statements</h1>
          <Link className={styles.upload} href="/statements/upload">
            <span className="material-symbols-outlined" aria-hidden="true">
              upload_file
            </span>
            Upload statements
          </Link>
        </div>
        <p className={styles.subtitle}>Everything you&rsquo;ve uploaded, newest first.</p>
      </header>

      {uploads.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No statements yet.</p>
          <p className={styles.emptyBody}>
            Upload your bank statements and we&rsquo;ll work out which payments need a document.
          </p>
          <Link className={styles.emptyAction} href="/statements/upload">
            Upload statements
          </Link>
        </div>
      ) : (
        uploads.map((upload) => (
          <section
            className={styles.group}
            key={upload.uploadBatchId}
            aria-label={`Upload of ${upload.uploadedAt.toLocaleDateString("en-IN", {
              dateStyle: "long",
            })}`}
          >
            <div className={styles.groupHead}>
              <h2 className={styles.groupTitle}>
                Uploaded{" "}
                {upload.uploadedAt.toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </h2>
              <Link className={styles.groupLink} href={`/statements/${upload.uploadBatchId}`}>
                {upload.statements.length === 1 ? "1 file" : `${upload.statements.length} files`}
                <span className="material-symbols-outlined" aria-hidden="true">
                  chevron_right
                </span>
              </Link>
            </div>

            <ul className={styles.list}>
              {upload.statements.map((statement) => (
                <StatementRow
                  key={statement.id}
                  statement={statement}
                  batchHref={`/statements/${upload.uploadBatchId}`}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {/* Only while something is actually moving; a settled history stops asking. */}
      {moving ? <PollWhileProcessing /> : null}
    </div>
  );
}

/** One file: what it is, where it got to, and the one thing to do next. */
function StatementRow({
  statement,
  batchHref,
}: {
  statement: HistoryStatement;
  batchHref: string;
}) {
  const details = [
    statement.account,
    statement.periodStart && statement.periodEnd
      ? `${statement.periodStart} to ${statement.periodEnd}`
      : null,
  ].filter(Boolean);

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className="material-symbols-outlined" aria-hidden="true">
          description
        </span>
        <span className={styles.filename}>{statement.filename}</span>
        <span className={styles.state} data-state={statement.state}>
          {statement.state.replace("_", " ").toLowerCase()}
        </span>
      </div>

      {details.length > 0 ? <p className={styles.detail}>{details.join(" · ")}</p> : null}

      {statement.state === "COMPLETED" ? (
        <Outcome statement={statement} href={`${batchHref}/${statement.id}`} />
      ) : (
        <p className={styles.message}>
          {statement.failureReason ?? STATEMENT_MESSAGES[statement.state] ?? statement.state}
          {statement.state === "NEEDS_ACCOUNT" ? (
            <>
              {" "}
              <Link className={styles.inlineLink} href={batchHref}>
                Choose the account
              </Link>
            </>
          ) : null}
        </p>
      )}
    </li>
  );
}

/** The parsing summary in one line (§7), and the way into the transactions. */
function Outcome({ statement, href }: { statement: HistoryStatement; href: string }) {
  const currency = currencyFor(statement.accountCurrency);
  const closing =
    currency && statement.closingBalance !== null
      ? formatAmount(statement.closingBalance, currency)
      : null;
  const valid = statement.validationOutcome === "VALID";

  return (
    <div className={styles.outcome}>
      <p className={styles.message}>
        {statement.lineCount === 1 ? "1 transaction" : `${statement.lineCount ?? 0} transactions`}
        {closing ? ` · closing balance ${closing}` : null}
      </p>
      <p className={styles.reconciled} data-outcome={statement.validationOutcome}>
        <span className="material-symbols-outlined" aria-hidden="true">
          {valid ? "check_circle" : "error"}
        </span>
        {valid ? "Transactions reconciled" : "The transactions could not be fully reconciled."}
      </p>
      <Link className={styles.inlineLink} href={href}>
        {valid ? "View transactions" : "Review"}
      </Link>
    </div>
  );
}
