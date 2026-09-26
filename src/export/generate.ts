/**
 * Build one export's file and store it.
 *
 * spec: docs/workflows/missing-invoice-report.md §9 · docs/architecture.md §12B, §15, §16
 * decision: docs/decisions/0017-reconciliation-export.md
 *
 * Background work only. The Inngest function is its one caller; a request never reaches it.
 *
 * The snapshot is everything read at the top of `generateExport`. It is built and stored
 * in the same call, so what the file says is what the database said when this attempt
 * began, and nothing written afterwards can change it: the object is never overwritten and
 * the row is never updated past `READY`.
 *
 * Every read goes through the scope and there is no join, for the reason
 * `src/report/report.ts` gives.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import {
  bankAccounts,
  bankStatements,
  canonicalTransactions,
  clarificationQuestions,
  invoiceDocuments,
  invoiceRequirements,
  invoices,
  reconciliationExports,
  reconciliationRuns,
  supportingDocuments,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { summarize } from "../report/summary";
import type { DocumentStore } from "../storage/document-store";
import { documentKey } from "../storage/keys";
import { reconciliationRows, type ExportDocument } from "./rows";
import { XLSX_MIME } from "./exports";
import { buildWorkbook } from "./workbook";

type Requirement = typeof invoiceRequirements.$inferSelect;
type Invoice = typeof invoices.$inferSelect;
type InvoiceDocument = typeof invoiceDocuments.$inferSelect;
type SupportingDocument = typeof supportingDocuments.$inferSelect;

export type GenerateOutcome = "generated" | "skipped";

/**
 * Build and store the file for one requested export.
 *
 * Idempotent by the row's state. Only a `GENERATING` export is built; one already `READY`
 * or `FAILED` is left alone, so a retry after success writes nothing, and a stray event
 * naming another workspace's export finds no row at all.
 *
 * Infrastructure failures -- the store, the database -- are thrown, for Inngest to retry.
 * Nothing is marked ready until the file is stored, so an attempt that fails part-way
 * leaves no download behind it.
 */
export async function generateExport(
  scope: WorkspaceScope,
  store: DocumentStore,
  exportId: string,
  origin: string,
  now: () => Date = () => new Date(),
): Promise<GenerateOutcome> {
  const requested = await scope.selectOne(
    reconciliationExports,
    eq(reconciliationExports.id, exportId),
  );
  if (!requested || requested.state !== "GENERATING") return "skipped";

  const [
    transactions,
    requirements,
    accounts,
    statements,
    runs,
    open,
    linkedInvoices,
    invoiceFiles,
    documents,
  ] = await Promise.all([
    scope.select(canonicalTransactions),
    scope.select(invoiceRequirements),
    scope.select(bankAccounts),
    scope.select(bankStatements, eq(bankStatements.state, "COMPLETED")),
    scope.select(reconciliationRuns),
    scope.select(clarificationQuestions, isNull(clarificationQuestions.answeredAt)),
    scope.select(invoices, isNotNull(invoices.canonicalTransactionId)),
    scope.select(invoiceDocuments),
    scope.select(supportingDocuments),
  ]);
  const generatedAt = now();

  const rows = reconciliationRows({
    transactions,
    requirements,
    accounts,
    documents: documentsByTransaction(requirements, linkedInvoices, invoiceFiles, documents),
    awaitingAnswer: new Set(
      open.flatMap((question) =>
        question.canonicalTransactionId ? [question.canonicalTransactionId] : [],
      ),
    ),
  });

  // The same header the report shows: the latest run, and the accounts coverage is read
  // from. `src/report/report.ts` explains both.
  const run = runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
  const covered = new Set(statements.map((statement) => statement.bankAccountId));

  const bytes = await buildWorkbook(rows, {
    origin,
    generatedAt,
    transactionsProcessed: transactions.length,
    summary: summarize(requirements),
    run: run
      ? { startedAt: run.startedAt, coverageStart: run.coverageStart, coverageEnd: run.coverageEnd }
      : null,
    accounts: accounts
      .filter((account) => covered.has(account.id))
      .map((account) => `${account.bankName} ${account.accountIdentifier}`),
  });

  const stored = await store.put(
    documentKey(scope.workspaceId, "exports", exportId, requested.filename),
    bytes,
    XLSX_MIME,
  );

  // Conditional on still GENERATING: an attempt that lost a race to a sibling does not
  // repoint a finished export at its own copy of the file.
  await scope.update(
    reconciliationExports,
    {
      state: "READY",
      storageRef: stored.key,
      transactionCount: rows.length,
      completedAt: now(),
    },
    and(eq(reconciliationExports.id, exportId), eq(reconciliationExports.state, "GENERATING")),
  );

  return "generated";
}

/**
 * The document each transaction is linked to, if any.
 *
 * In order of authority: the document that resolved its requirement; else the primary file
 * of an invoice linked to it (an upload for a payment the system never flagged still links
 * -- `manual-invoice-upload.md §14`); else a document linked to it directly without being
 * an invoice (`docs/domain-model.md §5.1`).
 *
 * Only an id and a filename leave this function. The storage reference stays behind.
 */
function documentsByTransaction(
  requirements: readonly Requirement[],
  linkedInvoices: readonly Invoice[],
  invoiceFiles: readonly InvoiceDocument[],
  documents: readonly SupportingDocument[],
): Map<string, ExportDocument> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const linked = new Map<string, ExportDocument>();

  const offer = (transactionId: string | null, documentId: string | null | undefined) => {
    if (!transactionId || !documentId || linked.has(transactionId)) return;
    const document = byId.get(documentId);
    if (document) linked.set(transactionId, { id: document.id, filename: document.filename });
  };

  for (const requirement of requirements) {
    offer(requirement.canonicalTransactionId, requirement.resolvedDocumentId);
  }

  for (const invoice of linkedInvoices) {
    const files = invoiceFiles.filter((file) => file.invoiceId === invoice.id);
    offer(
      invoice.canonicalTransactionId,
      (files.find((file) => file.isPrimary) ?? files[0])?.documentId,
    );
  }

  const direct = documents
    .filter((document) => document.canonicalTransactionId !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const document of direct) offer(document.canonicalTransactionId, document.id);

  return linked;
}
