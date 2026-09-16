/**
 * What happened to each file in one upload.
 *
 * `§11`: a batch is shown together and its files reach outcomes independently, so this is
 * a list of per-file states rather than one progress bar over the whole upload.
 *
 * Every word on it comes from the database. `architecture.md §14` asks exactly that — the
 * frontend reflects persisted workflow state rather than keeping its own — which is what
 * makes a refresh, or coming back tomorrow, show the truth.
 */

import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireScope } from "../../../../auth/workspace";
import { bankStatements } from "../../../../db/schema";
import { currencyFor } from "../../../../money/currencies";
import { accountsForBinding } from "../../../../statements/bind";
import { AccountPicker } from "./account-picker";
import { PollWhileProcessing } from "./poll";
import styles from "./page.module.css";

/** `docs/state-machines.md §1`, verbatim. The UI does not invent its own wording. */
const MESSAGES: Record<string, string> = {
  UPLOADING: "Uploading your statement…",
  IDENTIFYING: "Identifying your bank…",
  NEEDS_ACCOUNT: "Tell us which account this statement covers.",
  PARSING: "Extracting transactions…",
  VALIDATING: "Checking your transactions…",
  COMPLETED: "Statement processed.",
  FAILED: "We couldn't process this statement.",
};

/** States where a workflow is still running, and the page should keep looking. */
const IN_FLIGHT = new Set(["UPLOADING", "IDENTIFYING", "PARSING", "VALIDATING"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StatementBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  // A uuid column rejects a malformed value with an error rather than an empty result, so
  // the shape is checked before it reaches the database — the same reasoning as the
  // serving route in feature B.
  if (!UUID.test(batchId)) notFound();

  const scope = await requireScope();
  const statements = await scope.select(bankStatements, eq(bankStatements.uploadBatchId, batchId));
  // Another workspace's batch and a batch that never existed are the same answer.
  if (statements.length === 0) notFound();

  const waiting = statements.some((statement) => statement.state === "NEEDS_ACCOUNT");
  const accounts = waiting ? await accountsForBinding(scope) : [];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Your statements</h1>
        <p className={styles.subtitle}>
          Each file is processed on its own. You can leave this page — we&rsquo;ll keep going.
        </p>
      </header>

      <ul className={styles.list}>
        {statements.map((statement) => (
          <li className={styles.item} key={statement.id}>
            <div className={styles.itemHead}>
              <span className="material-symbols-outlined" aria-hidden="true">
                description
              </span>
              <span className={styles.filename}>{statement.filename}</span>
              <span className={styles.state} data-state={statement.state}>
                {statement.state.replace("_", " ").toLowerCase()}
              </span>
            </div>

            <p className={styles.message}>
              {statement.failureReason ?? MESSAGES[statement.state] ?? statement.state}
            </p>

            {statement.periodStart && statement.periodEnd ? (
              <p className={styles.period}>
                Covering {statement.periodStart} to {statement.periodEnd}
              </p>
            ) : null}

            {statement.state === "NEEDS_ACCOUNT" ? (
              <AccountPicker
                statementId={statement.id}
                accounts={accounts}
                suggestedBankName={statement.identifiedBankName}
                suggestedAccountIdentifier={statement.identifiedAccountIdentifier}
                // Only where the document named one we support. An unrecognised code is
                // why some of these statements are waiting in the first place, and
                // offering it back as a suggestion would suggest an answer we rejected.
                suggestedCurrency={currencyFor(statement.identifiedCurrency)?.code ?? null}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {/* Only while something is actually moving; a finished batch stops asking. */}
      {statements.some((statement) => IN_FLIGHT.has(statement.state)) ? (
        <PollWhileProcessing />
      ) : null}
    </div>
  );
}
