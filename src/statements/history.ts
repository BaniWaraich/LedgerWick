/**
 * Every statement this business has uploaded, grouped by the upload it arrived in.
 *
 * spec: docs/workflows/upload-statement.md §14
 *
 * The upload batch is the grouping because it is what the user did: one drop of files,
 * one moment. `§11` already makes the batch the unit of presentation, and the batch page
 * is where each group leads.
 *
 * Two scoped reads and a join in memory rather than a SQL join, for the reason
 * `src/requirements/identify.ts` gives: `WorkspaceScope` exposes no join, so that every
 * query carries the workspace filter.
 */

import type { WorkspaceScope } from "../db/workspace-scope";
import { bankAccounts, bankStatements } from "../db/schema";

type StatementRow = typeof bankStatements.$inferSelect;

export interface HistoryStatement extends StatementRow {
  /** The bank account it was bound to, as a person would name it. Null until bound. */
  account: string | null;
  /** That account's currency code, so figures can be shown in it. Null until bound. */
  accountCurrency: string | null;
}

export interface HistoryUpload {
  uploadBatchId: string;
  /** When the earliest file in the upload arrived. */
  uploadedAt: Date;
  statements: HistoryStatement[];
}

/** The workspace's uploads, newest first, each with its files in the order they arrived. */
export async function statementHistory(scope: WorkspaceScope): Promise<HistoryUpload[]> {
  const [statements, accounts] = await Promise.all([
    scope.select(bankStatements),
    scope.select(bankAccounts),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const uploads = new Map<string, HistoryUpload>();

  const byArrival = [...statements].sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime());

  for (const statement of byArrival) {
    const account = statement.bankAccountId ? accountById.get(statement.bankAccountId) : undefined;
    const upload = uploads.get(statement.uploadBatchId) ?? {
      uploadBatchId: statement.uploadBatchId,
      uploadedAt: statement.uploadedAt,
      statements: [],
    };

    upload.statements.push({
      ...statement,
      account: account
        ? [account.bankName, account.accountIdentifier].filter(Boolean).join(" ")
        : null,
      accountCurrency: account?.currency ?? null,
    });
    uploads.set(statement.uploadBatchId, upload);
  }

  return [...uploads.values()].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}
