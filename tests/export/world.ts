/**
 * A workspace with something in every line of the reconciliation.
 *
 * Shared by the export's integration and isolation tests, so both attack and check the
 * same shape of data.
 */

import { randomUUID } from "node:crypto";

import ExcelJS from "exceljs";

import { seedBankAccount, type TestDb } from "../helpers/db";
import {
  bankStatements,
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  reconciliationRuns,
  supportingDocuments,
} from "../../src/db/schema";
import type { WorkspaceScope } from "../../src/db/workspace-scope";
import { RECONCILIATION_SHEET } from "../../src/export/workbook";

export interface Reconciliation {
  readonly documentId: string;
  readonly storageRef: string;
  readonly reviewRequirementId: string;
  /** Every transaction description, in the order they were created. */
  readonly descriptions: readonly string[];
}

/**
 * Seed one of each: matched, not found, needs review, marked as needing no document, a
 * transaction nobody required anything for, and one waiting on a question.
 */
export async function seedReconciliation(
  h: TestDb,
  scope: WorkspaceScope,
  label: string,
): Promise<Reconciliation> {
  const account = await seedBankAccount(h.db, scope.workspaceId);

  await scope.insert(bankStatements, {
    bankAccountId: account.id,
    uploadBatchId: randomUUID(),
    filename: "statement.csv",
    mimeType: "text/csv",
    storageRef: `workspaces/${scope.workspaceId}/statements/x/statement.csv`,
    state: "COMPLETED",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
  });
  await scope.insert(reconciliationRuns, {
    state: "COMPLETED",
    coverageStart: "2026-03-01",
    coverageEnd: "2026-03-31",
  });

  const storageRef = `workspaces/${scope.workspaceId}/documents/${label}/invoice.pdf-0001`;
  const [document] = await scope.insert(supportingDocuments, {
    storageRef,
    filename: `${label}-invoice.pdf`,
    mimeType: "application/pdf",
    source: "MANUAL_UPLOAD",
    state: "EXTRACTED",
  });

  const kinds = ["MATCHED", "NOT_FOUND", "NEEDS_REVIEW", "NOT_REQUIRED", "NONE", "ASKED"] as const;
  const descriptions: string[] = [];
  let reviewRequirementId = "";

  for (const [i, kind] of kinds.entries()) {
    const description = `${label} PAYMENT ${kind}`;
    descriptions.push(description);
    const [transaction] = await scope.insert(canonicalTransactions, {
      bankAccountId: account.id,
      valueDate: `2026-03-0${i + 1}`,
      amountMinor: BigInt(10000 * (i + 1)),
      direction: "DEBIT",
      currency: "INR",
      description,
      descriptionNormalized: description.toLowerCase(),
    });

    if (kind === "NONE") continue;
    if (kind === "ASKED") {
      await scope.insert(clarificationQuestions, {
        canonicalTransactionId: transaction.id,
        question: "What was this payment for?",
      });
      continue;
    }

    const [requirement] = await scope.insert(invoiceRequirements, {
      canonicalTransactionId: transaction.id,
      state: kind === "MATCHED" || kind === "NOT_REQUIRED" ? "RESOLVED" : kind,
      resolutionMethod:
        kind === "MATCHED" ? "AUTO_MATCHED" : kind === "NOT_REQUIRED" ? "NOT_REQUIRED" : null,
      resolvedDocumentId: kind === "MATCHED" ? document.id : null,
      vendorGuess: `${label} Vendor`,
      reason: "A supplier payment.",
    });
    if (kind === "NEEDS_REVIEW") reviewRequirementId = requirement.id;
  }

  return { documentId: document.id, storageRef, reviewRequirementId, descriptions };
}

/** The reconciliation sheet's rows, as header-keyed records. */
export async function readRows(bytes: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet(RECONCILIATION_SHEET)!;

  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    rows.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value])));
  });
  return rows;
}

/** A stored object's bytes. */
export async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}
