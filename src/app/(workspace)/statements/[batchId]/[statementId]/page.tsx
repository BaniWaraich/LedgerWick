/**
 * The transactions one statement produced, as they were read.
 *
 * `upload-statement.md §6`: "The user should not be required to manually verify every
 * successfully extracted transaction as part of the normal flow. Detailed transaction
 * information may be available when the system detects a discrepancy or when the user
 * explicitly chooses to review it." This is that detail, reached from the summary and not
 * before.
 *
 * Deliberately read-only. `docs/phases/phase-1.md` defers the line-by-line correction tool
 * as "a product of its own"; what Phase 1 owes a user whose statement did not reconcile is
 * to say so, say by how much, and show them what was actually read.
 *
 * It shows statement lines rather than canonical transactions on purpose. A line is the
 * evidence of what this file said (Step 5a), and this page answers a question about this
 * file — where a canonical transaction may be shared with an overlapping statement and
 * would misrepresent what was read here.
 */

import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireScope } from "../../../../../auth/workspace";
import { bankAccounts, bankStatements, statementLines } from "../../../../../db/schema";
import { currencyFor } from "../../../../../money/currencies";
import { formatAmount } from "../../../../../money/format";
import styles from "./page.module.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StatementTransactionsPage({
  params,
}: {
  params: Promise<{ batchId: string; statementId: string }>;
}) {
  const { batchId, statementId } = await params;
  // A uuid column rejects a malformed value with an error rather than an empty result, so
  // the shape is checked first — the same reasoning as the batch page and the serving route.
  if (!UUID.test(batchId) || !UUID.test(statementId)) notFound();

  const scope = await requireScope();
  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  // Another workspace's statement and one that never existed are the same answer.
  if (!statement || statement.uploadBatchId !== batchId) notFound();

  const account = statement.bankAccountId
    ? await scope.selectOne(bankAccounts, eq(bankAccounts.id, statement.bankAccountId))
    : null;
  const currency = currencyFor(account?.currency);

  const lines = await scope.select(statementLines, eq(statementLines.statementId, statementId));
  lines.sort((a, b) => a.rowIndex - b.rowIndex);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href={`/statements/${batchId}`}>
          <span className="material-symbols-outlined" aria-hidden="true">
            arrow_back
          </span>
          Back to this upload
        </Link>
        <h1 className={styles.title}>{statement.filename}</h1>
        <p className={styles.subtitle}>
          {account ? `${account.bankName} · ${account.accountIdentifier}` : "Unbound statement"}
          {statement.periodStart && statement.periodEnd
            ? ` · ${statement.periodStart} to ${statement.periodEnd}`
            : ""}
        </p>
      </header>

      {lines.length === 0 ? (
        <p className={styles.empty}>No transactions were read from this statement.</p>
      ) : (
        <table className={styles.table}>
          <caption className={styles.caption}>
            {lines.length === 1 ? "1 transaction" : `${lines.length} transactions`}, in the order
            they appear in the file.
          </caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col" className={styles.numeric}>
                Amount
              </th>
              <th scope="col" className={styles.numeric}>
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td className={styles.date}>{line.valueDate}</td>
                <td>
                  {line.description}
                  {line.externalReference ? (
                    <span className={styles.reference}>{line.externalReference}</span>
                  ) : null}
                </td>
                <td className={styles.numeric} data-direction={line.direction}>
                  {currency
                    ? `${line.direction === "DEBIT" ? "−" : "+"}${formatAmount(line.amountMinor, currency)}`
                    : line.amountMinor.toString()}
                </td>
                <td className={styles.numeric}>
                  {line.balanceMinor !== null && currency
                    ? formatAmount(line.balanceMinor, currency)
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
